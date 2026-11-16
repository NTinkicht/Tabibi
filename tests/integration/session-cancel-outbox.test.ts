import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueInAppNotificationTargetResolver } from '@/modules/notification-domain/queue-in-app-target-resolver';
import type { NotificationIntent } from '@/modules/notification-outbox';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ids = {
  clinic: randomUUID(),
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
    ($1,'sco-reception','Reception'),($2,'sco-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,'sco-clinic','Clinic')`,
    [ids.clinic],
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
  for (let index = 0; index < 3; index++) {
    const item = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: `Secret Patient ${index}`,
      preferredLocale: index === 1 ? 'fr' : 'ar',
      contactPhone: '+213555000111',
      idempotencyKey: `register-sco-${index}`,
      correlationId: `register-${index}`,
    });
    entries.push(item.entry.id);
  }
  // entry 1 checked in, entry 2 cancelled before the session cancellation.
  await queue.command(scope, ids.session, entries[1]!, {
    command: 'check_in',
    idempotencyKey: 'ci-1',
    correlationId: 'ci-1',
  });
  await queue.command(scope, ids.session, entries[2]!, {
    command: 'cancel',
    reason: 'left',
    cancellationSource: 'clinic',
    idempotencyKey: 'cancel-2',
    correlationId: 'cancel-2',
  });
  await pool.query(`DELETE FROM notification_outbox`);
});
afterAll(() => pool.end());

const cancelSession = (key: string) =>
  new SessionService(pool).command(scope, ids.session, {
    command: 'cancel',
    reason: 'Doctor unavailable',
    idempotencyKey: key,
    correlationId: `corr-${key}`,
  });

async function intents() {
  return (
    await pool.query<{
      clinic_id: string;
      queue_entry_id: string;
      event_key: string;
      state: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT clinic_id,queue_entry_id,event_key,state,payload
         FROM notification_outbox ORDER BY queue_entry_id`,
    )
  ).rows;
}

describe('whole-session cancellation outbox atomicity', () => {
  it('writes one pending session_cancelled intent per cascaded entry only', async () => {
    expect(await intents()).toEqual([]);
    await cancelSession('cancel-session');
    const rows = await intents();
    expect(rows.map((row) => row.queue_entry_id).sort()).toEqual(
      [entries[0]!, entries[1]!].sort(),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        clinic_id: ids.clinic,
        event_key: 'session_cancelled',
        state: 'pending',
      });
      expect(Object.keys(row.payload)).toEqual(['locale']);
    }
    const byEntry = new Map(rows.map((row) => [row.queue_entry_id, row]));
    expect(byEntry.get(entries[0]!)!.payload).toEqual({ locale: 'ar' });
    expect(byEntry.get(entries[1]!)!.payload).toEqual({ locale: 'fr' });
    expect(JSON.stringify(rows)).not.toContain('Secret Patient');
    expect(JSON.stringify(rows)).not.toContain('555000111');
  });

  it('writes no intent for other session commands', async () => {
    const sessions = new SessionService(pool);
    await sessions.command(scope, ids.session, {
      command: 'pause',
      idempotencyKey: 'pause-1',
      correlationId: 'pause-1',
    });
    await sessions.command(scope, ids.session, {
      command: 'resume',
      idempotencyKey: 'resume-1',
      correlationId: 'resume-1',
    });
    expect(await intents()).toEqual([]);
  });

  it('replays an exact retry without adding intents', async () => {
    const first = await cancelSession('cancel-retry');
    const retry = await cancelSession('cancel-retry');
    expect(retry).toEqual(first);
    expect(await intents()).toHaveLength(2);
  });

  it('rolls back status, entries, audit, receipt and outbox on outbox failure', async () => {
    const count = async (table: string) =>
      (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    const before = {
      audit: await count('audit_events'),
      receipts: await count('session_command_receipts'),
    };
    await pool.query(`CREATE FUNCTION fail_outbox_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox down'; END $$`);
    await pool.query(`CREATE TRIGGER fail_outbox_insert BEFORE INSERT
      ON notification_outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert()`);
    try {
      await expect(cancelSession('cancel-fail')).rejects.toThrow('outbox down');
    } finally {
      await pool.query('DROP FUNCTION fail_outbox_insert() CASCADE');
    }
    const session = await pool.query<{ status: string }>(
      'SELECT status FROM consultation_sessions WHERE id=$1',
      [ids.session],
    );
    expect(session.rows[0]!.status).toBe('open');
    const states = await pool.query<{ state: string }>(
      'SELECT state FROM queue_entries WHERE id = ANY($1) ORDER BY id',
      [[entries[0], entries[1]]],
    );
    expect(states.rows.map((row) => row.state).sort()).toEqual([
      'checked_in',
      'waiting',
    ]);
    expect(await intents()).toEqual([]);
    expect(await count('audit_events')).toBe(before.audit);
    expect(await count('session_command_receipts')).toBe(before.receipts);
    // Positive control: with the failure removed the same command succeeds.
    const ok = await cancelSession('cancel-fail');
    expect(ok.status).toBe('cancelled');
    expect(await intents()).toHaveLength(2);
  });

  it('resolves each intent to the cancelled entry patient', async () => {
    await cancelSession('cancel-resolve');
    const resolver = new QueueInAppNotificationTargetResolver(pool);
    const loaded = await pool.query(
      `SELECT o.id, o.clinic_id AS "clinicId", o.queue_entry_id AS "queueEntryId",
              o.logical_target_key AS "logicalTargetKey", o.event_key AS "eventKey",
              q.patient_id AS "patientId"
         FROM notification_outbox o JOIN queue_entries q ON q.id=o.queue_entry_id`,
    );
    expect(loaded.rows).toHaveLength(2);
    for (const row of loaded.rows) {
      const target = await resolver.resolveTarget(row as NotificationIntent);
      expect(target).toMatchObject({
        subjectKind: 'visit_patient',
        subjectId: row.patientId,
      });
    }
  });
});
