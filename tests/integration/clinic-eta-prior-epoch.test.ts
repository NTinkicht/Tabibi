import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';

// TAB-P0-11 / #610 slice 2: the per-(clinic, doctor) historical prior epoch is
// bumped by database triggers at most once per committing transaction that adds,
// changes, removes or re-attributes a duration sample, and never otherwise.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  doctorUser: randomUUID(),
  doctorUser2: randomUUID(),
  doctor: randomUUID(),
  doctor2: randomUUID(),
  session: randomUUID(),
  sibling: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.admin };

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'prior-admin','Admin'),($2,'prior-doc','Doctor'),($3,'prior-doc2','Doctor 2')`,
    [ids.admin, ids.doctorUser, ids.doctorUser2],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'prior-clinic','Clinic'),($2,'prior-other','Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'clinic_admin')`,
    [ids.clinic, ids.admin],
  );
  for (const [doctor, user] of [
    [ids.doctor, ids.doctorUser],
    [ids.doctor2, ids.doctorUser2],
  ] as const) {
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
      [doctor, user],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [ids.clinic, doctor],
    );
  }
  for (const [id, hour, endHour] of [
    [ids.session, '09:00', '12:00'],
    [ids.sibling, '13:00', '16:00'],
  ] as const) {
    await pool.query(
      `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES($1,$2,$3,'2026-09-20',('2026-09-20 '||$4)::timestamptz,('2026-09-20 '||$5)::timestamptz,'planned')`,
      [id, ids.clinic, ids.doctor, hour, endHour],
    );
  }
});
afterAll(() => pool.end());

async function priorEpoch(
  doctor: string,
  clinic = ids.clinic,
): Promise<number> {
  const row = await pool.query<{ e: string }>(
    `SELECT eta_prior_epoch::text AS e FROM clinic_doctor_eta_prior_epochs
      WHERE clinic_id=$1 AND doctor_id=$2`,
    [clinic, doctor],
  );
  return row.rows[0] ? Number(row.rows[0].e) : 0;
}

async function sourceEpoch(sessionId: string): Promise<number> {
  const row = await pool.query<{ e: string }>(
    `SELECT eta_source_epoch::text AS e FROM consultation_sessions WHERE id=$1`,
    [sessionId],
  );
  return Number(row.rows[0]!.e);
}

let counter = 0;
const key = () => `prior-${++counter}`;
const sessions = () => new SessionService(pool);
const queue = () => new QueueService(pool);

async function openSession() {
  const k = key();
  await sessions().command(scope, ids.session, {
    command: 'open',
    idempotencyKey: k,
    correlationId: k,
  });
}

async function register(name: string) {
  const k = key();
  const registered = await queue().registerWalkIn(scope, ids.session, {
    privateDisplayName: name,
    preferredLocale: 'fr',
    idempotencyKey: k,
    correlationId: k,
  });
  return registered.entry.id;
}

function entryCommand(
  entryId: string,
  command:
    | 'check_in'
    | 'call'
    | 'start_consultation'
    | 'complete_consultation'
    | 'cancel',
) {
  const k = key();
  return queue().command(scope, ids.session, entryId, {
    command,
    reason: 'prior epoch test',
    cancellationSource: 'clinic',
    idempotencyKey: k,
    correlationId: k,
  });
}

async function runToStart(entryId: string) {
  for (const step of ['check_in', 'call', 'start_consultation'] as const)
    await entryCommand(entryId, step);
}

describe('clinic/doctor eta_prior_epoch (real PostgreSQL)', () => {
  it('has no row (epoch 0) until a duration sample exists', async () => {
    await openSession();
    const entry = await register('Prior one');
    await runToStart(entry);
    // Started but not completed is not a duration sample.
    expect(await priorEpoch(ids.doctor)).toBe(0);
  });

  it('bumps exactly once when a consultation completes, and only for its doctor', async () => {
    await openSession();
    const entry = await register('Prior two');
    await runToStart(entry);
    const sessionEpochBefore = await sourceEpoch(ids.sibling);
    await entryCommand(entry, 'complete_consultation');
    expect(await priorEpoch(ids.doctor)).toBe(1);
    expect(await priorEpoch(ids.doctor2)).toBe(0);
    expect(await priorEpoch(ids.doctor, ids.otherClinic)).toBe(0);
    // The sibling session's own source epoch is untouched: the prior epoch is
    // the only signal that its historical prior changed.
    expect(await sourceEpoch(ids.sibling)).toBe(sessionEpochBefore);
  });

  it('does not bump for non-sample queue changes', async () => {
    await openSession();
    const entry = await register('Prior three');
    await entryCommand(entry, 'check_in');
    const cancelled = await register('Prior four');
    await entryCommand(cancelled, 'cancel');
    await pool.query(
      `UPDATE queue_entries SET updated_at = now() WHERE id=$1`,
      [entry],
    );
    expect(await priorEpoch(ids.doctor)).toBe(0);
  });

  it('bumps for a timestamp correction of a sample and for its deletion', async () => {
    await openSession();
    const entry = await register('Prior five');
    await runToStart(entry);
    await entryCommand(entry, 'complete_consultation');
    expect(await priorEpoch(ids.doctor)).toBe(1);
    await pool.query(
      `UPDATE queue_entries SET completed_at = completed_at + interval '2 minutes' WHERE id=$1`,
      [entry],
    );
    expect(await priorEpoch(ids.doctor)).toBe(2);
    // Removing a sample (receipts reference the entry, so clear them first).
    await pool.query(`DELETE FROM queue_command_receipts`);
    await pool.query(`DELETE FROM queue_registration_receipts`);
    await pool.query(`DELETE FROM queue_entries WHERE id=$1`, [entry]);
    expect(await priorEpoch(ids.doctor)).toBe(3);
  });

  it('moves a sample between doctors when its session is re-attributed', async () => {
    await openSession();
    const entry = await register('Prior six');
    await runToStart(entry);
    await entryCommand(entry, 'complete_consultation');
    expect(await priorEpoch(ids.doctor)).toBe(1);
    await pool.query(
      `UPDATE consultation_sessions SET doctor_id=$2 WHERE id=$1`,
      [ids.session, ids.doctor2],
    );
    expect(await priorEpoch(ids.doctor)).toBe(2);
    expect(await priorEpoch(ids.doctor2)).toBe(1);
  });

  it('does not bump when a session with no samples changes doctor', async () => {
    await pool.query(
      `UPDATE consultation_sessions SET doctor_id=$2 WHERE id=$1`,
      [ids.sibling, ids.doctor2],
    );
    expect(await priorEpoch(ids.doctor)).toBe(0);
    expect(await priorEpoch(ids.doctor2)).toBe(0);
  });

  it('bumps once for many samples changed in one transaction and not on rollback', async () => {
    await openSession();
    const a = await register('Prior seven');
    const b = await register('Prior eight');
    await runToStart(a);
    await entryCommand(a, 'complete_consultation');
    await queue()
      .command(scope, ids.session, b, {
        command: 'check_in',
        reason: 'x',
        cancellationSource: 'clinic',
        idempotencyKey: key(),
        correlationId: key(),
      })
      .catch(() => undefined);
    const before = await priorEpoch(ids.doctor);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE queue_entries SET completed_at = completed_at + interval '1 minute' WHERE id=$1`,
        [a],
      );
      await client.query(
        `UPDATE queue_entries SET completed_at = completed_at + interval '1 minute' WHERE id=$1`,
        [a],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await priorEpoch(ids.doctor)).toBe(before);
    const committing = await pool.connect();
    try {
      await committing.query('BEGIN');
      await committing.query(
        `UPDATE queue_entries SET completed_at = completed_at + interval '1 minute' WHERE id=$1`,
        [a],
      );
      await committing.query(
        `UPDATE queue_entries SET completed_at = completed_at + interval '1 minute' WHERE id=$1`,
        [a],
      );
      await committing.query('COMMIT');
    } finally {
      committing.release();
    }
    expect(await priorEpoch(ids.doctor)).toBe(before + 1);
  });

  it('refuses direct writes, deletes and decreases of the prior epoch', async () => {
    await openSession();
    const entry = await register('Prior nine');
    await runToStart(entry);
    await entryCommand(entry, 'complete_consultation');
    const message = 'eta_prior_epoch is maintained by the database';
    await expect(
      pool.query(
        `UPDATE clinic_doctor_eta_prior_epochs SET eta_prior_epoch = 99 WHERE doctor_id=$1`,
        [ids.doctor],
      ),
    ).rejects.toThrow(message);
    await expect(
      pool.query(
        `UPDATE clinic_doctor_eta_prior_epochs SET eta_prior_epoch = 1 WHERE doctor_id=$1`,
        [ids.doctor],
      ),
    ).rejects.toThrow(message);
    await expect(
      pool.query(
        `DELETE FROM clinic_doctor_eta_prior_epochs WHERE doctor_id=$1`,
        [ids.doctor],
      ),
    ).rejects.toThrow(message);
    await expect(
      pool.query(
        `INSERT INTO clinic_doctor_eta_prior_epochs(clinic_id,doctor_id,eta_prior_epoch,eta_prior_epoch_xact)
         VALUES($1,$2,1,pg_current_xact_id())`,
        [ids.clinic, ids.doctor2],
      ),
    ).rejects.toThrow(message);
    expect(await priorEpoch(ids.doctor)).toBe(1);
  });
});
