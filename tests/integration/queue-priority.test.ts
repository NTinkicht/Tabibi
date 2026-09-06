import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import {
  QueueConflictError,
  QueueService,
  QueueValidationError,
} from '@/modules/queue';

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

describe('authorized deterministic queue reorder', () => {
  it('preserves registration evidence, records complete audit metadata, and exact-retries once', async () => {
    const first = await reorder(entries[2]!, 1, 0, 'move-third-first');
    expect(first.orderedEntryIds).toEqual([entries[2], entries[0], entries[1]]);
    expect(await reorder(entries[2]!, 1, 0, 'move-third-first')).toEqual(first);
    const rows = await pool.query<{
      id: string;
      registration_order: string;
      service_order: string;
    }>(
      `SELECT id,registration_order,service_order FROM queue_entries WHERE session_id=$1 ORDER BY service_order`,
      [ids.session],
    );
    expect(rows.rows.map((row) => row.id)).toEqual(first.orderedEntryIds);
    expect(
      rows.rows
        .sort(
          (a, b) => Number(a.registration_order) - Number(b.registration_order),
        )
        .map((row) => Number(row.registration_order)),
    ).toEqual([1, 2, 3]);
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action='queue_entry.reordered' AND entity_id=$1`,
      [entries[2]],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      sessionId: ids.session,
      previousVersion: 0,
      resultingVersion: 1,
      targetPosition: 1,
      reason: 'Operational accommodation',
      idempotencyKey: 'move-third-first',
    });
    expect(audit.rows[0]!.metadata.previousOrder).toHaveLength(3);
    expect(audit.rows[0]!.metadata.resultingOrder).toHaveLength(3);
  });

  it('serializes races, rejects stale commands, and leaves one deterministic valid order', async () => {
    const results = await Promise.allSettled([
      reorder(entries[2]!, 1, 0, 'race-a'),
      reorder(entries[1]!, 1, 0, 'race-b'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const orders = await pool.query<{ service_order: string }>(
      `SELECT service_order FROM queue_entries WHERE session_id=$1 AND state='checked_in' ORDER BY service_order`,
      [ids.session],
    );
    expect(orders.rows.map((row) => Number(row.service_order))).toEqual([
      1, 2, 3,
    ]);
    await expect(reorder(entries[0]!, 2, 0, 'stale')).rejects.toThrow(
      /Stale queue order version/,
    );
  });

  it('rejects missing reasons, ineligible states, cross-clinic scope, and bypassing service order', async () => {
    await expect(
      new QueueService(pool).reorder(scope, ids.session, entries[0]!, {
        targetPosition: 1,
        expectedVersion: 0,
        reason: ' ',
        idempotencyKey: 'blank',
        correlationId: 'blank',
      }),
    ).rejects.toBeInstanceOf(QueueValidationError);
    await pool.query(
      `UPDATE queue_entries SET state='called',service_order=NULL WHERE id=$1`,
      [entries[0]],
    );
    await expect(
      reorder(entries[0]!, 1, 0, 'ineligible'),
    ).rejects.toBeInstanceOf(QueueConflictError);
    await expect(
      new QueueService(pool).reorder(
        { clinicId: ids.otherClinic, actorUserId: ids.otherReceptionist },
        ids.session,
        entries[1]!,
        {
          targetPosition: 1,
          expectedVersion: 0,
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
        entries[1]!,
        {
          targetPosition: 1,
          expectedVersion: 0,
          reason: 'Unauthorized',
          idempotencyKey: 'doctor',
          correlationId: 'doctor',
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('makes normal call selection consume committed service order', async () => {
    await reorder(entries[2]!, 1, 0, 'call-order');
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
  });
});
