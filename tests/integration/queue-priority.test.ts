import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import { QueueConflictError, QueueService } from '@/modules/queue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  receptionist: randomUUID(),
  otherReceptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
let entries: string[] = [];

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'priority-reception','Reception'),($2,'priority-other','Other'),($3,'priority-doctor','Doctor')`,
    [ids.receptionist, ids.otherReceptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
    ($1,'priority-clinic','Clinic'),($2,'priority-other-clinic','Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
    ($1,$3,'receptionist'),($2,$4,'receptionist')`,
    [ids.clinic, ids.otherClinic, ids.receptionist, ids.otherReceptionist],
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
    const registered = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: `Patient ${index}`,
      preferredLocale: 'ar',
      idempotencyKey: `priority-register-${index}`,
      correlationId: `register-${index}`,
    });
    entries.push(registered.entry.id);
    await queue.command(scope, ids.session, registered.entry.id, {
      command: 'check_in',
      idempotencyKey: `priority-check-in-${index}`,
      correlationId: `check-in-${index}`,
    });
  }
});
afterAll(() => pool.end());

function reorder(
  entryId: string,
  targetPosition: number,
  expectedVersion: number,
  idempotencyKey: string,
) {
  return new QueueService(pool).reorder(scope, ids.session, entryId, {
    targetPosition,
    expectedVersion,
    idempotencyKey,
    reason: 'Operational accommodation',
    correlationId: `corr-${idempotencyKey}`,
  });
}

describe('authorized deterministic queue priority', () => {
  it('inserts and moves a contiguous priority cohort without rewriting evidence', async () => {
    const inserted = await reorder(entries[2]!, 1, 3, 'insert-third');
    expect(inserted.orderedEntryIds).toEqual([entries[2]]);
    await reorder(entries[0]!, 2, 4, 'insert-first-second');
    const moved = await reorder(entries[0]!, 1, 5, 'move-first-first');
    expect(moved.orderedEntryIds).toEqual([entries[0], entries[2]]);
    expect(await reorder(entries[0]!, 1, 5, 'move-first-first')).toEqual(moved);

    const rows = await pool.query<{
      id: string;
      registration_order: string;
      eligibility_order: string;
      priority_order: string | null;
    }>(
      `SELECT id,registration_order,eligibility_order,priority_order
          FROM queue_entries WHERE session_id=$1 ORDER BY registration_order`,
      [ids.session],
    );
    expect(rows.rows.map((row) => Number(row.registration_order))).toEqual([
      1, 2, 3,
    ]);
    expect(rows.rows.map((row) => Number(row.eligibility_order))).toEqual([
      1, 2, 3,
    ]);
    expect(
      rows.rows.map((row) =>
        row.priority_order === null ? null : Number(row.priority_order),
      ),
    ).toEqual([1, null, 2]);
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action='queue_entry.reordered' AND entity_id=$1`,
      [entries[0]],
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[1]!.metadata).toMatchObject({
      previousVersion: 5,
      resultingVersion: 6,
      targetPosition: 1,
      reason: 'Operational accommodation',
      idempotencyKey: 'move-first-first',
    });
  });

  it('serializes concurrent priority inserts and rejects the stale command', async () => {
    const results = await Promise.allSettled([
      reorder(entries[2]!, 1, 3, 'race-a'),
      reorder(entries[1]!, 1, 3, 'race-b'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const orders = await pool.query<{ priority_order: string }>(
      `SELECT priority_order FROM queue_entries WHERE session_id=$1
        AND priority_order IS NOT NULL ORDER BY priority_order`,
      [ids.session],
    );
    expect(orders.rows.map((row) => Number(row.priority_order))).toEqual([1]);
    await expect(reorder(entries[0]!, 1, 3, 'stale')).rejects.toThrow(
      /Stale queue order version/,
    );
  });

  it('compacts the priority cohort on lifecycle exit and exact-retries once', async () => {
    await reorder(entries[0]!, 1, 3, 'priority-one');
    await reorder(entries[1]!, 2, 4, 'priority-two');
    await reorder(entries[2]!, 3, 5, 'priority-three');
    const registrationBefore = await pool.query<{
      id: string;
      registration_order: string;
      eligibility_order: string;
    }>(
      `SELECT id,registration_order,eligibility_order FROM queue_entries WHERE session_id=$1 ORDER BY registration_order`,
      [ids.session],
    );
    const queue = new QueueService(pool);
    const command = {
      command: 'no_show' as const,
      reason: 'Patient left before being called',
      idempotencyKey: 'priority-no-show',
      correlationId: 'priority-no-show',
    };
    expect(
      (await queue.command(scope, ids.session, entries[1]!, command)).state,
    ).toBe('no_show');
    expect(
      (await queue.command(scope, ids.session, entries[1]!, command)).state,
    ).toBe('no_show');
    const rows = await pool.query<{ id: string; priority_order: string }>(
      `SELECT id,priority_order FROM queue_entries WHERE session_id=$1
        AND state IN ('waiting','checked_in') AND priority_order IS NOT NULL ORDER BY priority_order`,
      [ids.session],
    );
    expect(
      rows.rows.map((row) => [row.id, Number(row.priority_order)]),
    ).toEqual([
      [entries[0], 1],
      [entries[2], 2],
    ]);
    expect(
      (
        await pool.query(
          `SELECT id,registration_order,eligibility_order FROM queue_entries WHERE session_id=$1 ORDER BY registration_order`,
          [ids.session],
        )
      ).rows,
    ).toEqual(registrationBefore.rows);
    const version = await pool.query<{ queue_order_version: string }>(
      'SELECT queue_order_version FROM consultation_sessions WHERE id=$1',
      [ids.session],
    );
    expect(Number(version.rows[0]!.queue_order_version)).toBe(7);
    expect(
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::int count FROM audit_events WHERE action='queue_entry.no_show' AND entity_id=$1`,
          [entries[1]],
        )
      ).rows[0]!.count,
    ).toBe(1);
  });

  it('supports waiting inserts, enforces insert/move bounds, roles, and tenants', async () => {
    const queue = new QueueService(pool);
    const waiting = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: 'Waiting priority',
      preferredLocale: 'fr',
      idempotencyKey: 'waiting-register',
      correlationId: 'waiting-register',
    });
    const inserted = await reorder(waiting.entry.id, 1, 3, 'waiting-priority');
    expect(inserted.entry.priorityOrder).toBe(1);
    await expect(
      reorder(entries[0]!, 3, 4, 'insert-out-of-range'),
    ).rejects.toThrow(/allowed maximum of 2/);
    await expect(
      reorder(waiting.entry.id, 2, 4, 'move-out-of-range'),
    ).rejects.toThrow(/allowed maximum of 1/);
    await expect(
      new QueueService(pool).reorder(
        { clinicId: ids.otherClinic, actorUserId: ids.otherReceptionist },
        ids.session,
        waiting.entry.id,
        {
          targetPosition: 1,
          expectedVersion: 4,
          reason: 'Cross tenant',
          idempotencyKey: 'cross',
          correlationId: 'cross',
        },
      ),
    ).rejects.toBeInstanceOf(QueueConflictError);
    await expect(
      new QueueService(pool).reorder(
        { clinicId: ids.clinic, actorUserId: ids.doctorUser },
        ids.session,
        waiting.entry.id,
        {
          targetPosition: 1,
          expectedVersion: 4,
          reason: 'Unauthorized',
          idempotencyKey: 'doctor',
          correlationId: 'doctor',
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('calls checked-in priority entries first and rejects stale reorder after lifecycle mutation', async () => {
    await reorder(entries[2]!, 1, 3, 'call-priority');
    const queue = new QueueService(pool);
    await expect(
      queue.command(scope, ids.session, entries[0]!, {
        command: 'call',
        idempotencyKey: 'wrong-call',
        correlationId: 'wrong-call',
      }),
    ).rejects.toThrow(/not next/);
    expect(
      (
        await queue.command(scope, ids.session, entries[2]!, {
          command: 'call',
          idempotencyKey: 'right-call',
          correlationId: 'right-call',
        })
      ).state,
    ).toBe('called');
    await expect(
      reorder(entries[0]!, 1, 4, 'stale-after-call'),
    ).rejects.toThrow(/Stale queue order version/);
    expect(
      (
        await pool.query<{ priority_order: string | null }>(
          'SELECT priority_order FROM queue_entries WHERE id=$1',
          [entries[2]],
        )
      ).rows[0]!.priority_order,
    ).toBeNull();
  });
});
