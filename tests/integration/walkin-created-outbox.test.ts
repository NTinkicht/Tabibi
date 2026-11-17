import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ids = {
  clinic: randomUUID(),
  user: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  closedSession: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.user };
const service = () => new QueueService(pool);

function register(key: string, extra: Record<string, unknown> = {}) {
  return service().registerWalkIn(scope, ids.session, {
    privateDisplayName: 'Secret Walkin',
    preferredLocale: 'fr',
    idempotencyKey: key,
    correlationId: `corr-${key}`,
    ...extra,
  });
}

async function intents() {
  return (
    await pool.query<{
      queue_entry_id: string;
      event_key: string;
      state: string;
      logical_target_key: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT queue_entry_id,event_key,state,logical_target_key,payload
         FROM notification_outbox ORDER BY created_at`,
    )
  ).rows;
}

async function counts() {
  const q = async (table: string) =>
    (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  return {
    patients: await q('patient_operational_records'),
    entries: await q('queue_entries'),
    audit: await q('audit_events'),
    receipts: await q('queue_registration_receipts'),
  };
}

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
     ($1,'wco-reception','Reception'),($2,'wco-doctor','Doctor')`,
    [ids.user, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,'wco-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES ($1,$2,'receptionist')`,
    [ids.clinic, ids.user],
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
     VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE+time '09:00',CURRENT_DATE+time '12:00','open'),
           ($4,$2,$3,CURRENT_DATE,CURRENT_DATE+time '13:00',CURRENT_DATE+time '15:00','closed')`,
    [ids.session, ids.clinic, ids.doctor, ids.closedSession],
  );
});
afterAll(() => pool.end());

describe('walk-in registration outbox atomicity', () => {
  it('writes exactly one pending queue_entry_created intent with locale only', async () => {
    const registered = await register('w-1', {
      contactPhone: '+213555000222',
      contactEmail: 'secret@example.test',
    });
    const rows = await intents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queue_entry_id: registered.entry.id,
      event_key: 'queue_entry_created',
      state: 'pending',
      logical_target_key: `queue-entry:${registered.entry.id}`,
      payload: { locale: 'fr' },
    });
    expect(Object.keys(rows[0]!.payload)).toEqual(['locale']);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('Secret Walkin');
    expect(serialized).not.toContain('555000222');
    expect(serialized).not.toContain('secret@example.test');
  });

  it('writes no intent for a contact-less walk-in', async () => {
    const registered = await register('w-2');
    expect(registered.entry.id).toBeTruthy();
    expect(await intents()).toEqual([]);
  });

  it('answers an exact retry from the receipt without a second intent', async () => {
    const first = await register('w-3', { contactEmail: 'a@example.test' });
    const retry = await register('w-3', { contactEmail: 'a@example.test' });
    expect(retry.entry.id).toBe(first.entry.id);
    expect(await intents()).toHaveLength(1);
  });

  it('rolls back patient, entry, audit and receipt when the outbox write fails', async () => {
    const before = await counts();
    await pool.query(`CREATE FUNCTION fail_outbox_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox down'; END $$`);
    await pool.query(`CREATE TRIGGER fail_outbox_insert BEFORE INSERT
      ON notification_outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert()`);
    try {
      await expect(
        register('w-4', { contactPhone: '+213555000333' }),
      ).rejects.toThrow('outbox down');
    } finally {
      await pool.query('DROP FUNCTION fail_outbox_insert() CASCADE');
    }
    expect(await counts()).toEqual(before);
    expect(await intents()).toEqual([]);
    // Positive control: with the failure removed the same request succeeds.
    await register('w-4', { contactPhone: '+213555000333' });
    expect(await intents()).toHaveLength(1);
    expect((await counts()).entries).toBe(before.entries + 1);
  });

  it('does not collide with a queue command whose key ends in :created', async () => {
    await register('visit-1', { contactPhone: '+213555000666' });
    const other = await register('w-other', { contactPhone: '+213555000777' });
    await service().command(scope, ids.session, other.entry.id, {
      command: 'check_in',
      idempotencyKey: 'ci-other',
      correlationId: 'corr-ci',
    });
    const called = await service().command(scope, ids.session, other.entry.id, {
      command: 'call',
      idempotencyKey: 'visit-1:created',
      correlationId: 'corr-call',
    });
    expect(called.state).toBe('called');
    expect((await intents()).map((row) => row.event_key).sort()).toEqual([
      'patient_called',
      'queue_entry_created',
      'queue_entry_created',
    ]);
  });

  it('creates no intent when registration is refused', async () => {
    await expect(
      service().registerWalkIn(scope, ids.closedSession, {
        privateDisplayName: 'Late',
        preferredLocale: 'ar',
        contactPhone: '+213555000444',
        idempotencyKey: 'w-5',
        correlationId: 'corr-w-5',
      }),
    ).rejects.toThrow();
    await expect(
      service().registerWalkIn(
        { clinicId: ids.clinic, actorUserId: randomUUID() },
        ids.session,
        {
          privateDisplayName: 'Intruder',
          preferredLocale: 'ar',
          contactPhone: '+213555000555',
          idempotencyKey: 'w-6',
          correlationId: 'corr-w-6',
        },
      ),
    ).rejects.toThrow();
    expect(await intents()).toEqual([]);
  });
});
