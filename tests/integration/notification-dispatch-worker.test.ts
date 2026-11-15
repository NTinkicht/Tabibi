import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { GuestLinkIntentStore } from '@/modules/guest-access/link-intents';
import { NotificationDispatchService } from '@/modules/notification-domain';
import { NotificationDispatchBatchRunner } from '@/modules/notification-domain/dispatch-batch';
import {
  dispatchIntervalMs,
  runDispatchTick,
} from '@/modules/notification-domain/dispatch-worker';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { NotificationDispatchEligibilityRepository } from '@/modules/notification-outbox/dispatch-eligibility';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const SECRET = 'w'.repeat(48);
const MATERIAL = 'worker-test-link-material-77aa';
const clinicA = randomUUID();
const clinicB = randomUUID();
const store = new GuestLinkIntentStore(pool, new GuestLinkEnvelope(SECRET));
const outbox = new NotificationOutboxRepository(pool);

const deliveryContext = {
  resolve: async (intent: { clinicId: string }) => ({
    target: {
      subjectKind: 'visit_patient' as const,
      subjectId: '00000000-0000-0000-0000-000000000001',
      channel: 'sms' as const,
    },
    preference: {
      id: '00000000-0000-0000-0000-000000000002',
      clinicId: intent.clinicId,
      subjectKind: 'visit_patient' as const,
      subjectId: '00000000-0000-0000-0000-000000000001',
      channel: 'sms' as const,
      preferenceState: 'enabled' as const,
      consentState: 'granted' as const,
      revision: 1,
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    },
  }),
};

type Dispatch = () => Promise<{ kind: 'delivered' }>;

function runner(dispatch: Dispatch | ReturnType<typeof vi.fn>) {
  return new NotificationDispatchBatchRunner(
    new NotificationDispatchEligibilityRepository(pool),
    new NotificationDispatchService(
      outbox,
      { dispatch: dispatch as never },
      deliveryContext as never,
    ),
  );
}

function enqueue(clinicId: string, key: string) {
  return outbox.enqueue({
    clinicId,
    logicalTargetKey: `queue-entry:${key}`,
    eventKey: 'turn_approaching',
    intentVersion: 1,
    idempotencyKey: `worker:${key}`,
    payload: { locale: 'en', places: 2 },
  });
}

async function addLinkIntents(count: number): Promise<string[]> {
  const doctorUser = randomUUID();
  const doctorId = randomUUID();
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'wrk-doc','Doc')`,
    [doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr')`,
    [doctorId, doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [clinicA, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,now()::date,now()-interval '1 hour',
            now()+interval '2 hours','open')`,
    [sessionId, clinicA, doctorId],
  );
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const patientId = randomUUID();
    const entryId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records
         (id,clinic_id,private_display_name,preferred_locale)
       VALUES($1,$2,'Guest','ar')`,
      [patientId, clinicA],
    );
    await pool.query(
      `INSERT INTO queue_entries
         (id,clinic_id,session_id,patient_id,state,source,
          registration_order,public_display_label)
       VALUES($1,$2,$3,$4,'waiting','walk_in',$5,$6)`,
      [entryId, clinicA, sessionId, patientId, i + 1, `WRK-${i + 1}`],
    );
    ids.push(
      await store.create({
        clinicId: clinicA,
        queueEntryId: entryId,
        intent: 'initial',
        material: MATERIAL,
        exchangeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }),
    );
  }
  return ids;
}

beforeAll(migrate);
afterAll(async () => pool.end());
beforeEach(async () => {
  await pool.query(`TRUNCATE notification_outbox, guest_link_intents,
    queue_entries, patient_operational_records, consultation_sessions,
    doctor_clinics, doctor_profiles, clinics, users CASCADE`);
  for (const [id, key] of [
    [clinicA, 'wrk-a'],
    [clinicB, 'wrk-b'],
  ] as const) {
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,$2,$2)`,
      [id, key],
    );
  }
});

describe('notification dispatch worker tick, real PostgreSQL (#884)', () => {
  it('delivers due intents in every clinic and leaves non-due ones', async () => {
    const dispatch = vi.fn(async () => ({ kind: 'delivered' as const }));
    const due = await enqueue(clinicA, 'due');
    const dueB = await enqueue(clinicB, 'due-b');
    const notDue = await enqueue(clinicA, 'not-due');
    const claim = await outbox.claimPendingIntent({
      clinicId: clinicA,
      intentId: notDue.id,
      leaseMs: 60_000,
    });
    await outbox.completeDispatchAttempt({
      clinicId: clinicA,
      intentId: notDue.id,
      claimToken: claim!.claimToken,
      outcome: 'failed',
    });

    const counts = await runDispatchTick({
      pool,
      outboxRunner: runner(dispatch),
      linkStore: store,
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(counts).toMatchObject({ clinics: 2, delivered: 2, errors: 0 });
    const states = await pool.query<{ id: string; state: string }>(
      'SELECT id, state FROM notification_outbox',
    );
    const byId = new Map(states.rows.map((r) => [r.id, r.state]));
    expect(byId.get(due.id)).toBe('delivered');
    expect(byId.get(dueB.id)).toBe('delivered');
    expect(byId.get(notDue.id)).toBe('failed');
  });

  it('two workers on one database never deliver an intent twice', async () => {
    const dispatch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { kind: 'delivered' as const };
    });
    for (let i = 0; i < 12; i += 1) await enqueue(clinicA, `race-${i}`);
    const linkIds = await addLinkIntents(8);
    const sent: string[] = [];
    const linkSender = async (_m: string, ctx: { intentId: string }) => {
      sent.push(ctx.intentId);
    };
    const deps = {
      pool,
      outboxRunner: runner(dispatch),
      linkStore: store,
      linkSender,
    };

    await Promise.all([runDispatchTick(deps), runDispatchTick(deps)]);

    expect(dispatch).toHaveBeenCalledTimes(12);
    expect(new Set(sent).size).toBe(sent.length);
    expect([...sent].sort()).toEqual([...linkIds].sort());
    const left = await pool.query(
      `SELECT count(*)::int AS n FROM notification_outbox WHERE state <> 'delivered'`,
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('skips link dispatch without a sender and scrubs expired intents', async () => {
    const [pendingId] = await addLinkIntents(2);
    const [expiredId] = (
      await pool.query<{ id: string }>(
        `SELECT id FROM guest_link_intents WHERE id <> $1`,
        [pendingId],
      )
    ).rows.map((r) => r.id);
    await pool.query(
      `UPDATE guest_link_intents SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 second' WHERE id=$1`,
      [expiredId],
    );

    const counts = await runDispatchTick({
      pool,
      outboxRunner: runner(vi.fn()),
      linkStore: store,
    });

    expect(counts.scrubbed).toBe(1);
    expect(counts.delivered).toBe(0);
    const rows = await pool.query<{
      id: string;
      state: string;
      envelope_ciphertext: string | null;
    }>('SELECT id, state, envelope_ciphertext FROM guest_link_intents');
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(expiredId!)).toMatchObject({
      state: 'expired',
      envelope_ciphertext: null,
    });
    expect(byId.get(pendingId!)).toMatchObject({ state: 'pending' });
    expect(byId.get(pendingId!)!.envelope_ciphertext).not.toBeNull();
  });

  it('result and thrown errors carry counts only, no ids or material', async () => {
    const queued = await enqueue(clinicA, 'log-check');
    await addLinkIntents(1);
    const failing = vi.fn(async () => {
      throw new Error(`boom ${queued.id} ${MATERIAL}`);
    });
    const counts = await runDispatchTick({
      pool,
      outboxRunner: runner(failing),
      linkStore: store,
      linkSender: async () => undefined,
    });
    const logged = JSON.stringify(counts);
    expect(logged).not.toContain(queued.id);
    expect(logged).not.toContain(clinicA);
    expect(logged).not.toContain(MATERIAL);
    expect(Object.values(counts).every((v) => typeof v === 'number')).toBe(
      true,
    );
  });
});

describe('dispatchIntervalMs', () => {
  it('defaults to 15000 and rejects out-of-range values', () => {
    expect(dispatchIntervalMs(undefined)).toBe(15_000);
    expect(dispatchIntervalMs('2000')).toBe(2000);
    expect(() => dispatchIntervalMs('10')).toThrow();
    expect(() => dispatchIntervalMs('abc')).toThrow();
  });
});
