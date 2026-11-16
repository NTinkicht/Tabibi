import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueInAppNotificationTargetResolver } from '@/modules/notification-domain/queue-in-app-target-resolver';
import type { NotificationIntent } from '@/modules/notification-outbox';
import { QueueService } from '@/modules/queue';
import { QueueRestoreService } from '@/modules/queue/restore';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
let entries: string[] = [];

beforeAll(migrate);
beforeEach(async () => {
  await pool.query('DROP FUNCTION IF EXISTS fail_outbox_insert() CASCADE');
  await pool.query(`TRUNCATE notification_outbox, audit_events,
    queue_command_receipts, queue_registration_receipts, queue_entries,
    patient_operational_records, session_command_receipts,
    consultation_sessions, schedule_templates, doctor_clinics, doctor_profiles,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'qco-reception','Reception'),($2,'qco-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
    ($1,'qco-clinic','Clinic'),($2,'qco-other','Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
    ($1,$2,'receptionist')`,
    [ids.clinic, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
    VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE+time '09:00',CURRENT_DATE+time '12:00','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  const queue = new QueueService(pool);
  entries = [];
  for (let index = 0; index < 2; index++) {
    const item = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: `Secret Patient ${index}`,
      preferredLocale: index === 0 ? 'ar' : 'fr',
      contactPhone: '+213555000111',
      idempotencyKey: `register-qco-${index}`,
      correlationId: `register-${index}`,
    });
    entries.push(item.entry.id);
  }
});
afterAll(() => pool.end());

function run(
  name: Parameters<QueueService['command']>[3]['command'],
  entry: string,
  key: string,
  extra: Partial<Parameters<QueueService['command']>[3]> = {},
) {
  return new QueueService(pool).command(scope, ids.session, entry, {
    command: name,
    idempotencyKey: key,
    correlationId: `corr-${key}`,
    ...extra,
  });
}

async function intents() {
  const result = await pool.query<{
    clinic_id: string;
    queue_entry_id: string;
    event_key: string;
    intent_version: string;
    state: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT clinic_id,queue_entry_id,event_key,intent_version,state,payload
       FROM notification_outbox ORDER BY created_at, intent_version`,
  );
  return result.rows;
}

describe('queue command outbox atomicity', () => {
  it('writes exactly one pending patient_called intent with the call', async () => {
    await run('check_in', entries[0]!, 'ci-0');
    expect(await intents()).toEqual([]);
    const called = await run('call', entries[0]!, 'call-0');
    expect(called.state).toBe('called');
    const rows = await intents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clinic_id: ids.clinic,
      queue_entry_id: entries[0],
      event_key: 'patient_called',
      state: 'pending',
      payload: { locale: 'ar' },
    });
    expect(Object.keys(rows[0]!.payload)).toEqual(['locale']);
    expect(JSON.stringify(rows)).not.toContain('Secret Patient');
    expect(JSON.stringify(rows)).not.toContain('555000111');
  });

  it('writes a queue_entry_cancelled intent and none for other commands', async () => {
    await run('check_in', entries[1]!, 'ci-1');
    expect(await intents()).toEqual([]);
    await run('cancel', entries[1]!, 'cancel-1', {
      reason: 'patient left',
      cancellationSource: 'clinic',
    });
    const rows = await intents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_key: 'queue_entry_cancelled',
      queue_entry_id: entries[1],
      payload: { locale: 'fr' },
    });
  });

  it('replays an exact retry from the receipt without a second intent', async () => {
    await run('check_in', entries[0]!, 'ci-0');
    const first = await run('call', entries[0]!, 'call-retry');
    const retry = await run('call', entries[0]!, 'call-retry');
    expect(retry).toEqual(first);
    expect(await intents()).toHaveLength(1);
  });

  it('rolls back state, audit, receipt and outbox when the outbox write fails', async () => {
    await run('check_in', entries[0]!, 'ci-0');
    const before = {
      audit: await pool.query('SELECT count(*)::int AS n FROM audit_events'),
      receipts: await pool.query(
        'SELECT count(*)::int AS n FROM queue_command_receipts',
      ),
    };
    await pool.query(`CREATE FUNCTION fail_outbox_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox down'; END $$`);
    await pool.query(`CREATE TRIGGER fail_outbox_insert BEFORE INSERT
      ON notification_outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert()`);
    try {
      await expect(run('call', entries[0]!, 'call-fail')).rejects.toThrow(
        'outbox down',
      );
    } finally {
      await pool.query('DROP FUNCTION fail_outbox_insert() CASCADE');
    }
    const state = await pool.query<{ state: string }>(
      'SELECT state FROM queue_entries WHERE id=$1',
      [entries[0]],
    );
    expect(state.rows[0]!.state).toBe('checked_in');
    expect(await intents()).toEqual([]);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0]
        .n,
    ).toBe(before.audit.rows[0].n);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM queue_command_receipts',
        )
      ).rows[0].n,
    ).toBe(before.receipts.rows[0].n);
    // Positive control: with the failure removed the same command succeeds.
    const ok = await run('call', entries[0]!, 'call-fail');
    expect(ok.state).toBe('called');
    expect(await intents()).toHaveLength(1);
  });

  it('advances the version when a restored entry is cancelled again', async () => {
    const cancel = (key: string) =>
      run('cancel', entries[0]!, key, {
        reason: 'again',
        cancellationSource: 'clinic',
      });
    await cancel('cancel-a');
    await pool.query(`UPDATE queue_entries SET state='waiting' WHERE id=$1`, [
      entries[0],
    ]);
    await cancel('cancel-b');
    const rows = await intents();
    expect(rows.map((row) => Number(row.intent_version))).toEqual([1, 2]);
    expect(rows.map((row) => row.state)).toEqual(['superseded', 'pending']);
  });

  it('keeps intents clinic-scoped to the acting clinic', async () => {
    await run('check_in', entries[0]!, 'ci-0');
    await run('call', entries[0]!, 'call-0');
    const rows = await intents();
    expect(rows.every((row) => row.clinic_id === ids.clinic)).toBe(true);
  });

  it('persists the canonical lowercase id for an uppercase request id', async () => {
    await run('cancel', entries[0]!.toUpperCase(), 'cancel-up', {
      reason: 'upper',
      cancellationSource: 'clinic',
    });
    const rows = await pool.query<{
      queue_entry_id: string;
      logical_target_key: string;
    }>('SELECT queue_entry_id,logical_target_key FROM notification_outbox');
    expect(rows.rows).toEqual([
      {
        queue_entry_id: entries[0],
        logical_target_key: `queue-entry:${entries[0]}`,
      },
    ]);
    const resolver = new QueueInAppNotificationTargetResolver(pool);
    const intent = await pool.query(
      `SELECT id, clinic_id AS "clinicId", queue_entry_id AS "queueEntryId",
              logical_target_key AS "logicalTargetKey", event_key AS "eventKey"
         FROM notification_outbox`,
    );
    expect(
      await resolver.resolveTarget(intent.rows[0] as NotificationIntent),
    ).not.toBeNull();
  });

  it('does not deliver a cancellation after the entry was restored', async () => {
    await run('cancel', entries[0]!, 'cancel-r', {
      reason: 'mistake',
      cancellationSource: 'clinic',
    });
    const resolver = new QueueInAppNotificationTargetResolver(pool);
    const load = async () =>
      (
        await pool.query(
          `SELECT id, clinic_id AS "clinicId", queue_entry_id AS "queueEntryId",
                  logical_target_key AS "logicalTargetKey", event_key AS "eventKey"
             FROM notification_outbox WHERE event_key='queue_entry_cancelled'`,
        )
      ).rows[0] as NotificationIntent;
    // Positive control: while cancelled the intent resolves.
    expect(await resolver.resolveTarget(await load())).not.toBeNull();
    await new QueueRestoreService(pool).restore(
      scope,
      ids.session,
      entries[0]!,
      {
        checkIn: false,
        reason: 'restore',
        idempotencyKey: 'restore-r',
        correlationId: 'restore-r',
      },
    );
    expect(await resolver.resolveTarget(await load())).toBeNull();
  });
});
