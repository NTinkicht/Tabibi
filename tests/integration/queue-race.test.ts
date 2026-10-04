import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
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
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'race-reception','Reception'),($2,'race-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'race-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
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
    const registered = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: `Race Patient ${index}`,
      preferredLocale: 'ar',
      idempotencyKey: `race-register-${index}`,
      correlationId: `race-register-${index}`,
    });
    entries.push(registered.entry.id);
    await queue.command(scope, ids.session, registered.entry.id, {
      command: 'check_in',
      idempotencyKey: `race-check-in-${index}`,
      correlationId: `race-check-in-${index}`,
    });
  }
});
afterAll(() => pool.end());

function reorder(entryId: string, expectedVersion: number, key: string) {
  return new QueueService(pool).reorder(scope, ids.session, entryId, {
    targetPosition: 1,
    expectedVersion,
    idempotencyKey: key,
    reason: 'Deterministic race regression',
    correlationId: key,
  });
}

async function version(): Promise<number> {
  const row = await pool.query<{ queue_order_version: string }>(
    'SELECT queue_order_version FROM consultation_sessions WHERE id=$1',
    [ids.session],
  );
  return Number(row.rows[0]!.queue_order_version);
}

async function auditCount(action: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM audit_events WHERE action=$1',
    [action],
  );
  return Number(result.rows[0]!.count);
}

describe('deterministic queue concurrency regressions', () => {
  it('serializes same-entry concurrent call-next attempts into one called slot', async () => {
    const queue = new QueueService(pool);
    const results = await Promise.allSettled([
      queue.command(scope, ids.session, entries[0]!, {
        command: 'call',
        idempotencyKey: 'call-race-a',
        correlationId: 'call-race-a',
      }),
      queue.command(scope, ids.session, entries[0]!, {
        command: 'call',
        idempotencyKey: 'call-race-b',
        correlationId: 'call-race-b',
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const called = await pool.query<{ id: string }>(
      `SELECT id FROM queue_entries WHERE session_id=$1 AND state='called'`,
      [ids.session],
    );
    expect(called.rows.map((row) => row.id)).toEqual([entries[0]]);
    expect(await version()).toBe(4);
    expect(await auditCount('queue_entry.call')).toBe(1);
  });

  it('allows only one same-version priority override to commit', async () => {
    const results = await Promise.allSettled([
      reorder(entries[1]!, 3, 'priority-race-a'),
      reorder(entries[2]!, 3, 'priority-race-b'),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await version()).toBe(4);
    expect(await auditCount('queue_entry.reordered')).toBe(1);

    const priority = await pool.query<{
      id: string;
      priority_order: string;
    }>(
      `SELECT id,priority_order FROM queue_entries
        WHERE session_id=$1 AND priority_order IS NOT NULL
        ORDER BY priority_order,registration_order`,
      [ids.session],
    );
    expect(priority.rows).toHaveLength(1);
    expect([entries[1], entries[2]]).toContain(priority.rows[0]!.id);
    expect(Number(priority.rows[0]!.priority_order)).toBe(1);
  });

  it('serializes call-next against a same-version priority override and rejects the stale loser', async () => {
    const queue = new QueueService(pool);
    const results = await Promise.allSettled([
      queue.command(scope, ids.session, entries[0]!, {
        command: 'call',
        idempotencyKey: 'call-versus-priority-call',
        correlationId: 'call-versus-priority-call',
      }),
      reorder(entries[2]!, 3, 'call-versus-priority-reorder'),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await version()).toBe(4);

    const durable = await pool.query<{
      id: string;
      state: string;
      priority_order: string | null;
    }>(
      `SELECT id,state,priority_order FROM queue_entries
        WHERE session_id=$1 AND (state='called' OR priority_order IS NOT NULL)
        ORDER BY registration_order`,
      [ids.session],
    );
    expect(durable.rows).toHaveLength(1);

    if (durable.rows[0]!.state === 'called') {
      expect(durable.rows[0]!.id).toBe(entries[0]);
      await expect(reorder(entries[2]!, 3, 'stale-after-call-race')).rejects.toThrow(
        /Stale queue order version/,
      );
    } else {
      expect(durable.rows[0]!.id).toBe(entries[2]);
      expect(Number(durable.rows[0]!.priority_order)).toBe(1);
      const called = await queue.command(scope, ids.session, entries[2]!, {
        command: 'call',
        idempotencyKey: 'call-after-priority-race',
        correlationId: 'call-after-priority-race',
      });
      expect(called.state).toBe('called');
      expect(await version()).toBe(5);
    }
  });

  it('applies an override-first commit before selecting call-next', async () => {
    const overridden = await reorder(entries[2]!, 3, 'override-first');
    expect(overridden.queueOrderVersion).toBe(4);
    expect(overridden.orderedEntryIds).toEqual([entries[2]]);

    const queue = new QueueService(pool);
    await expect(
      queue.command(scope, ids.session, entries[0]!, {
        command: 'call',
        idempotencyKey: 'override-first-wrong-call',
        correlationId: 'override-first-wrong-call',
      }),
    ).rejects.toThrow(/not next/);

    const called = await queue.command(scope, ids.session, entries[2]!, {
      command: 'call',
      idempotencyKey: 'override-first-right-call',
      correlationId: 'override-first-right-call',
    });
    expect(called.state).toBe('called');
    expect(await version()).toBe(5);

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE action='queue_entry.reordered' AND entity_id=$1`,
      [entries[2]],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      previousVersion: 3,
      resultingVersion: 4,
      targetPosition: 1,
    });
  });
});
