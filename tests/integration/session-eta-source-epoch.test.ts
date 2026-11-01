import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';

// TAB-P0-11 / #610 slice 1: eta_source_epoch is bumped by database triggers at
// most once per committing transaction that changes an ETA source, and never
// otherwise. It is distinct from queue_order_version.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ids = {
  clinic: randomUUID(),
  admin: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  other: randomUUID(),
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
    ($1,'epoch-admin','Admin'),($2,'epoch-doctor','Doctor')`,
    [ids.admin, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'epoch-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'clinic_admin')`,
    [ids.clinic, ids.admin],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  for (const [id, hour, endHour] of [
    [ids.session, '09:00', '12:00'],
    [ids.other, '13:00', '16:00'],
  ] as const) {
    await pool.query(
      `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES($1,$2,$3,'2026-09-20',('2026-09-20 '||$4)::timestamptz,('2026-09-20 '||$5)::timestamptz,'planned')`,
      [id, ids.clinic, ids.doctor, hour, endHour],
    );
  }
});
afterAll(() => pool.end());

async function epochs(): Promise<Record<string, number>> {
  const rows = await pool.query<{ id: string; epoch: string }>(
    `SELECT id, eta_source_epoch::text AS epoch FROM consultation_sessions`,
  );
  return Object.fromEntries(rows.rows.map((r) => [r.id, Number(r.epoch)]));
}

async function orderVersion(): Promise<number> {
  const row = await pool.query<{ v: string }>(
    `SELECT queue_order_version::text AS v FROM consultation_sessions WHERE id=$1`,
    [ids.session],
  );
  return Number(row.rows[0]!.v);
}

const sessions = () => new SessionService(pool);
const queue = () => new QueueService(pool);
let counter = 0;
const key = () => `epoch-${++counter}`;

function sessionCommand(command: 'open' | 'pause' | 'resume' | 'close') {
  const k = key();
  return sessions().command(scope, ids.session, {
    command,
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
    | 'no_show'
    | 'cancel',
) {
  const k = key();
  return queue().command(scope, ids.session, entryId, {
    command,
    reason: 'epoch test',
    cancellationSource: 'clinic',
    idempotencyKey: k,
    correlationId: k,
  });
}

describe('session eta_source_epoch (real PostgreSQL)', () => {
  it('starts at zero and bumps once for each session lifecycle change', async () => {
    expect((await epochs())[ids.session]).toBe(0);
    await sessionCommand('open');
    expect((await epochs())[ids.session]).toBe(1);
    await sessionCommand('pause');
    expect((await epochs())[ids.session]).toBe(2);
    await sessionCommand('resume');
    expect((await epochs())[ids.session]).toBe(3);
    await sessionCommand('close');
    expect((await epochs())[ids.session]).toBe(4);
    expect((await epochs())[ids.other]).toBe(0);
  });

  it('bumps for delay declare, update and clear, and not for a refused or replayed delay', async () => {
    await sessionCommand('open');
    const base = (await epochs())[ids.session]!;
    const versionBefore = await orderVersion();
    const delay = (
      command: 'declare_delay' | 'update_delay' | 'clear_delay',
      expectedVersion: number,
      k: string,
      minutes?: number,
    ) =>
      sessions().delay(scope, ids.session, {
        command,
        expectedVersion,
        idempotencyKey: k,
        correlationId: k,
        ...(minutes === undefined ? {} : { minutes }),
      });
    await delay('declare_delay', 0, 'd-declare', 15);
    await delay('update_delay', 1, 'd-update', 30);
    await delay('clear_delay', 2, 'd-clear');
    expect((await epochs())[ids.session]).toBe(base + 3);
    // The ordering revision is a different concept and does not move.
    expect(await orderVersion()).toBe(versionBefore);
    // Exact retry (receipt replay) and a stale refusal change nothing.
    await delay('clear_delay', 2, 'd-clear');
    await expect(delay('update_delay', 0, 'd-stale', 5)).rejects.toThrow();
    expect((await epochs())[ids.session]).toBe(base + 3);
  });

  it('bumps for every queue source change and leaves queue_order_version alone', async () => {
    await sessionCommand('open');
    const afterOpen = (await epochs())[ids.session]!;
    const first = await register('Epoch one');
    expect((await epochs())[ids.session]).toBe(afterOpen + 1);
    const steps = [
      'check_in',
      'call',
      'start_consultation',
      'complete_consultation',
    ] as const;
    let expected = afterOpen + 1;
    for (const step of steps) {
      await entryCommand(first, step);
      expect((await epochs())[ids.session]).toBe(++expected);
    }
    const second = await register('Epoch two');
    await entryCommand(second, 'check_in');
    await entryCommand(second, 'no_show');
    const third = await register('Epoch three');
    await entryCommand(third, 'cancel');
    expect((await epochs())[ids.session]).toBe(expected + 3 + 2);
    expect((await epochs())[ids.other]).toBe(0);
  });

  it('bumps for a priority/ordering column change', async () => {
    await sessionCommand('open');
    const entryId = await register('Order epoch');
    const before = (await epochs())[ids.session]!;
    await pool.query(
      `UPDATE queue_entries SET priority_order = 1 WHERE id = $1`,
      [entryId],
    );
    expect((await epochs())[ids.session]).toBe(before + 1);
  });

  it('bumps for a consultation timestamp correction without a state change', async () => {
    await sessionCommand('open');
    const entryId = await register('Timing epoch');
    for (const step of ['check_in', 'call', 'start_consultation'] as const)
      await entryCommand(entryId, step);
    const before = (await epochs())[ids.session]!;
    await pool.query(
      `UPDATE queue_entries SET in_consultation_started_at = in_consultation_started_at - interval '5 minutes' WHERE id = $1`,
      [entryId],
    );
    expect((await epochs())[ids.session]).toBe(before + 1);
    await entryCommand(entryId, 'complete_consultation');
    const afterComplete = (await epochs())[ids.session]!;
    await pool.query(
      `UPDATE queue_entries SET completed_at = completed_at + interval '1 minute' WHERE id = $1`,
      [entryId],
    );
    expect((await epochs())[ids.session]).toBe(afterComplete + 1);
  });

  it('does not bump for an irrelevant column write', async () => {
    await sessionCommand('open');
    const entryId = await register('Quiet epoch');
    const before = await epochs();
    await pool.query(
      `UPDATE queue_entries SET updated_at = now() WHERE id=$1`,
      [entryId],
    );
    await pool.query(
      `UPDATE consultation_sessions SET updated_at = now() WHERE id=$1`,
      [ids.session],
    );
    expect(await epochs()).toEqual(before);
  });

  it('bumps both sessions exactly once for a transfer between sessions', async () => {
    await sessionCommand('open');
    const entryId = await register('Transfer epoch');
    const before = await epochs();
    await pool.query(`UPDATE queue_entries SET session_id=$2 WHERE id=$1`, [
      entryId,
      ids.other,
    ]);
    const after = await epochs();
    expect(after[ids.session]).toBe(before[ids.session]! + 1);
    expect(after[ids.other]).toBe(before[ids.other]! + 1);
  });

  it('bumps once per transaction even when a transaction touches many sources', async () => {
    await sessionCommand('open');
    const waiting = await register('Cascade one');
    const checkedIn = await register('Cascade two');
    await entryCommand(checkedIn, 'check_in');
    const before = (await epochs())[ids.session]!;
    const k = key();
    await sessions().command(scope, ids.session, {
      command: 'cancel',
      reason: 'clinic closure',
      idempotencyKey: k,
      correlationId: k,
    });
    const states = await pool.query(
      `SELECT state FROM queue_entries WHERE id = ANY($1::uuid[])`,
      [[waiting, checkedIn]],
    );
    expect(states.rows.map((r) => r.state)).toEqual(['cancelled', 'cancelled']);
    expect((await epochs())[ids.session]).toBe(before + 1);
  });

  it('rolls the epoch back with a rolled-back transaction', async () => {
    await sessionCommand('open');
    const before = await epochs();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE consultation_sessions SET status='paused' WHERE id=$1`,
        [ids.session],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await epochs()).toEqual(before);
  });

  it('refuses direct writes and decreases of the epoch', async () => {
    await sessionCommand('open');
    await expect(
      pool.query(
        `UPDATE consultation_sessions SET eta_source_epoch = 99 WHERE id=$1`,
        [ids.session],
      ),
    ).rejects.toThrow('eta_source_epoch is maintained by the database');
    await expect(
      pool.query(
        `UPDATE consultation_sessions SET eta_source_epoch = 0 WHERE id=$1`,
        [ids.session],
      ),
    ).rejects.toThrow('eta_source_epoch is maintained by the database');
  });
});
