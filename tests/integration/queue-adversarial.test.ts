import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueConflictError, QueueService } from '@/modules/queue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const FIXED_SEED = Number(process.env.QA_FIXED_SEED ?? '20260907');

const ids = {
  clinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};

const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };

function mulberry32(seed: number) {
  return function next() {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(migrate);

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'qa-adversarial-reception','Reception'),
      ($2,'qa-adversarial-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'qa-adversarial-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
      ($1,$2,'receptionist'),
      ($1,$3,'doctor')`,
    [ids.clinic, ids.receptionist, ids.doctorUser],
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
});

afterAll(async () => {
  await pool.end();
});

async function queueOrderVersion(queue: QueueService) {
  return (await queue.listOperational(scope, ids.session)).queueOrderVersion;
}

async function assertQueueInvariants() {
  const rows = await pool.query<{
    id: string;
    state: string;
    registration_order: string;
    eligibility_order: string | null;
    priority_order: string | null;
    public_display_label: string;
  }>(
    `SELECT id,state,registration_order,eligibility_order,priority_order,public_display_label
       FROM queue_entries
      WHERE session_id=$1
      ORDER BY registration_order`,
    [ids.session],
  );

  expect(rows.rows.map((row) => Number(row.registration_order))).toEqual(
    Array.from({ length: rows.rows.length }, (_, index) => index + 1),
  );
  expect(
    rows.rows.every((row) => /^W-[A-F0-9]{10}$/.test(row.public_display_label)),
  ).toBe(true);
  expect(new Set(rows.rows.map((row) => row.public_display_label)).size).toBe(
    rows.rows.length,
  );
  expect(
    rows.rows
      .filter((row) => row.state === 'waiting')
      .every((row) => row.eligibility_order === null),
  ).toBe(true);

  const priorityCohort = rows.rows.filter(
    (row) =>
      ['waiting', 'checked_in'].includes(row.state) &&
      row.priority_order !== null,
  );
  expect(
    priorityCohort
      .map((row) => Number(row.priority_order))
      .sort((left, right) => left - right),
  ).toEqual(
    Array.from({ length: priorityCohort.length }, (_, index) => index + 1),
  );

  const calledOrConsulting = rows.rows.filter((row) =>
    ['called', 'in_consultation'].includes(row.state),
  );
  expect(calledOrConsulting.length <= 1).toBe(true);

  const operational = await new QueueService(pool).listOperational(
    scope,
    ids.session,
  );
  const checkedInOperational = operational.entries
    .filter((entry) => entry.state === 'checked_in')
    .map((entry) => entry.id);
  const expectedCheckedInOrder = rows.rows
    .filter((row) => row.state === 'checked_in')
    .sort((left, right) => {
      const leftPriority =
        left.priority_order === null ? Infinity : Number(left.priority_order);
      const rightPriority =
        right.priority_order === null ? Infinity : Number(right.priority_order);
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      const leftEligibility =
        left.eligibility_order === null
          ? Infinity
          : Number(left.eligibility_order);
      const rightEligibility =
        right.eligibility_order === null
          ? Infinity
          : Number(right.eligibility_order);
      if (leftEligibility !== rightEligibility)
        return leftEligibility - rightEligibility;
      return Number(left.registration_order) - Number(right.registration_order);
    })
    .map((row) => row.id);
  expect(checkedInOperational).toEqual(expectedCheckedInOrder);
}

describe('deterministic adversarial queue coverage', () => {
  it('replays a fixed-seed operational sequence and preserves invariants after every step', async () => {
    const queue = new QueueService(pool);
    const next = mulberry32(FIXED_SEED);
    const entries: string[] = [];

    for (let index = 0; index < 4; index++) {
      const registration = await queue.registerWalkIn(scope, ids.session, {
        privateDisplayName: `Seeded Patient ${Math.floor(next() * 10_000)}`,
        preferredLocale: next() > 0.5 ? 'fr' : 'ar',
        idempotencyKey: `seed-register-${index}`,
        correlationId: `seed-register-${index}`,
      });
      entries.push(registration.entry.id);
      await assertQueueInvariants();
    }

    for (const [index, entry] of entries.slice(0, 3).entries()) {
      await queue.command(scope, ids.session, entry, {
        command: 'check_in',
        idempotencyKey: `seed-check-in-${index}`,
        correlationId: `seed-check-in-${index}`,
      });
      await assertQueueInvariants();
    }

    await queue.reorder(scope, ids.session, entries[2]!, {
      targetPosition: 1,
      expectedVersion: await queueOrderVersion(queue),
      reason: 'Seeded priority insertion',
      idempotencyKey: 'seed-reorder-1',
      correlationId: 'seed-reorder-1',
    });
    await assertQueueInvariants();

    await queue.reorder(scope, ids.session, entries[0]!, {
      targetPosition: 2,
      expectedVersion: await queueOrderVersion(queue),
      reason: 'Seeded priority move',
      idempotencyKey: 'seed-reorder-2',
      correlationId: 'seed-reorder-2',
    });
    await assertQueueInvariants();

    await queue.command(scope, ids.session, entries[1]!, {
      command: 'no_show',
      reason: 'Seeded absent patient',
      idempotencyKey: 'seed-no-show',
      correlationId: 'seed-no-show',
    });
    await assertQueueInvariants();

    await queue.command(scope, ids.session, entries[3]!, {
      command: 'check_in',
      idempotencyKey: 'seed-check-in-3',
      correlationId: 'seed-check-in-3',
    });
    await assertQueueInvariants();

    await queue.reorder(scope, ids.session, entries[3]!, {
      targetPosition: next() > 0.5 ? 1 : 2,
      expectedVersion: await queueOrderVersion(queue),
      reason: 'Seeded late-arrival priority',
      idempotencyKey: 'seed-reorder-3',
      correlationId: 'seed-reorder-3',
    });
    await assertQueueInvariants();

    expect(
      (
        await queue.command(scope, ids.session, entries[3]!, {
          command: 'call',
          idempotencyKey: 'seed-call',
          correlationId: 'seed-call',
        })
      ).state,
    ).toBe('called');
    await assertQueueInvariants();

    expect(
      (
        await queue.command(scope, ids.session, entries[3]!, {
          command: 'start_consultation',
          idempotencyKey: 'seed-start',
          correlationId: 'seed-start',
        })
      ).state,
    ).toBe('in_consultation');
    await assertQueueInvariants();

    expect(
      (
        await queue.command(scope, ids.session, entries[3]!, {
          command: 'complete_consultation',
          idempotencyKey: 'seed-complete',
          correlationId: 'seed-complete',
        })
      ).state,
    ).toBe('completed');
    await assertQueueInvariants();
  });

  it('returns exact retries and rejects conflicting idempotency reuse across register, command, and reorder', async () => {
    const queue = new QueueService(pool);
    const first = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: 'Retry patient',
      preferredLocale: 'ar',
      idempotencyKey: 'receipt-register',
      correlationId: 'receipt-register',
    });
    const registerRetry = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: 'Retry patient',
      preferredLocale: 'ar',
      idempotencyKey: 'receipt-register',
      correlationId: 'receipt-register',
    });
    expect(registerRetry).toEqual(first);
    await expect(
      queue.registerWalkIn(scope, ids.session, {
        privateDisplayName: 'Mutated retry patient',
        preferredLocale: 'fr',
        idempotencyKey: 'receipt-register',
        correlationId: 'receipt-register-different',
      }),
    ).rejects.toBeInstanceOf(QueueConflictError);

    const checkedIn = await queue.command(scope, ids.session, first.entry.id, {
      command: 'check_in',
      idempotencyKey: 'receipt-command',
      correlationId: 'receipt-command',
    });
    const commandRetry = await queue.command(
      scope,
      ids.session,
      first.entry.id,
      {
        command: 'check_in',
        idempotencyKey: 'receipt-command',
        correlationId: 'receipt-command',
      },
    );
    expect(commandRetry).toEqual(checkedIn);
    await expect(
      queue.command(scope, ids.session, first.entry.id, {
        command: 'cancel',
        reason: 'Conflicting receipt reuse',
        cancellationSource: 'clinic',
        idempotencyKey: 'receipt-command',
        correlationId: 'receipt-command-different',
      }),
    ).rejects.toBeInstanceOf(QueueConflictError);

    const second = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: 'Priority patient',
      preferredLocale: 'fr',
      idempotencyKey: 'receipt-register-2',
      correlationId: 'receipt-register-2',
    });
    await queue.command(scope, ids.session, second.entry.id, {
      command: 'check_in',
      idempotencyKey: 'receipt-command-2',
      correlationId: 'receipt-command-2',
    });

    const snapshot = await queue.listOperational(scope, ids.session);
    const reordered = await queue.reorder(scope, ids.session, second.entry.id, {
      targetPosition: 1,
      expectedVersion: snapshot.queueOrderVersion,
      reason: 'Retryable priority change',
      idempotencyKey: 'receipt-reorder',
      correlationId: 'receipt-reorder',
    });
    const reorderRetry = await queue.reorder(
      scope,
      ids.session,
      second.entry.id,
      {
        targetPosition: 1,
        expectedVersion: snapshot.queueOrderVersion,
        reason: 'Retryable priority change',
        idempotencyKey: 'receipt-reorder',
        correlationId: 'receipt-reorder',
      },
    );
    expect(reorderRetry).toEqual(reordered);
    await expect(
      queue.reorder(scope, ids.session, second.entry.id, {
        targetPosition: 2,
        expectedVersion: snapshot.queueOrderVersion,
        reason: 'Conflicting priority change',
        idempotencyKey: 'receipt-reorder',
        correlationId: 'receipt-reorder-different',
      }),
    ).rejects.toBeInstanceOf(QueueConflictError);
  });
});
