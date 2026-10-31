import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueConflictError, QueueService } from '@/modules/queue';
import {
  QUEUE_COMMANDS,
  queueCommandSessionGate,
  type QueueCommand,
} from '@/modules/queue/lifecycle-contract';
import type { SessionStatus } from '@/modules/session';

// TAB-P0-05: real-PostgreSQL proof of the session-status x queue-command gate
// (queueCommandSessionGate) enforced by QueueService.command.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ids = {
  clinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
const STATUSES: readonly SessionStatus[] = [
  'planned',
  'open',
  'paused',
  'closed',
  'cancelled',
];
// The queue state each command legally starts from, so the session gate is
// the only thing that can refuse it.
const PATH_TO_SOURCE: Readonly<Record<QueueCommand, readonly QueueCommand[]>> =
  {
    check_in: [],
    call: ['check_in'],
    no_show: ['check_in'],
    cancel: ['check_in'],
    start_consultation: ['check_in', 'call'],
    complete_consultation: ['check_in', 'call', 'start_consultation'],
  };

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'gate-reception','Reception'),($2,'gate-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'gate-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
    ($1,$2,'receptionist'),($1,$3,'doctor')`,
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
afterAll(() => pool.end());

function run(command: QueueCommand, entryId: string, key: string) {
  return new QueueService(pool).command(scope, ids.session, entryId, {
    command,
    reason: 'gate test',
    cancellationSource: 'clinic',
    idempotencyKey: key,
    correlationId: `corr-${key}`,
  });
}

async function setStatus(status: SessionStatus) {
  await pool.query(`UPDATE consultation_sessions SET status=$2 WHERE id=$1`, [
    ids.session,
    status,
  ]);
}

/** Registers one waiting entry and drives it, while the session is open, to
 * the state from which `command` is legal. */
async function entryReadyFor(
  command: QueueCommand,
  status: SessionStatus,
): Promise<string> {
  const queue = new QueueService(pool);
  const registered = await queue.registerWalkIn(scope, ids.session, {
    privateDisplayName: 'Gate patient',
    preferredLocale: 'fr',
    idempotencyKey: `register-${command}`,
    correlationId: `register-${command}`,
  });
  const entryId = registered.entry.id;
  // The database already refuses to close or cancel a session that still has
  // active entries, so a terminal session only ever holds terminal entries.
  // The session gate must refuse every command there regardless.
  const path: readonly QueueCommand[] =
    status === 'closed' || status === 'cancelled'
      ? ['check_in', 'call', 'start_consultation', 'complete_consultation']
      : PATH_TO_SOURCE[command];
  for (const step of path) await run(step, entryId, `setup-${command}-${step}`);
  return entryId;
}

async function snapshot() {
  const [entries, audit, receipts] = await Promise.all([
    pool.query(`SELECT row_to_json(e) AS row FROM queue_entries e ORDER BY id`),
    pool.query(`SELECT count(*)::int AS count FROM audit_events`),
    pool.query(`SELECT count(*)::int AS count FROM queue_command_receipts`),
  ]);
  return {
    entries: entries.rows,
    audit: audit.rows[0].count as number,
    receipts: receipts.rows[0].count as number,
  };
}

describe('session status x queue command gate (real PostgreSQL)', () => {
  it('covers every queue command and session status in the matrix', () => {
    expect(QUEUE_COMMANDS).toHaveLength(6);
    expect(Object.keys(PATH_TO_SOURCE).sort()).toEqual(
      [...QUEUE_COMMANDS].sort(),
    );
  });

  for (const status of STATUSES) {
    for (const command of QUEUE_COMMANDS) {
      const gate = queueCommandSessionGate(status, command);
      it(`${status} session + ${command}: ${gate}`, async () => {
        const entryId = await entryReadyFor(command, status);
        await setStatus(status);
        const before = await snapshot();
        const attempt = run(command, entryId, `gate-${status}-${command}`);
        if (gate === 'allowed') {
          await expect(attempt).resolves.toBeDefined();
          const after = await snapshot();
          expect(after.audit).toBe(before.audit + 1);
          expect(after.receipts).toBe(before.receipts + 1);
          return;
        }
        await expect(attempt).rejects.toBeInstanceOf(QueueConflictError);
        await expect(
          run(command, entryId, `gate-msg-${status}-${command}`),
        ).rejects.toThrow(
          gate === 'session_paused'
            ? 'Cannot call or start a consultation while the session is paused'
            : 'Queue lifecycle commands require an open or paused session',
        );
        // Refusal writes nothing: entries, audit and receipts are unchanged.
        expect(await snapshot()).toEqual(before);
      });
    }
  }

  it('does not make a paused refusal sticky: call succeeds after resume', async () => {
    const entryId = await entryReadyFor('call', 'open');
    await setStatus('paused');
    await expect(run('call', entryId, 'call-paused')).rejects.toThrow(
      'Cannot call or start a consultation while the session is paused',
    );
    await setStatus('open');
    await run('call', entryId, 'call-resumed');
    const state = await pool.query(
      `SELECT state FROM queue_entries WHERE id=$1`,
      [entryId],
    );
    expect(state.rows[0].state).toBe('called');
  });
});
