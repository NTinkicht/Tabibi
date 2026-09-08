import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as delayRoute } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/delay/route';
import { migrate } from '../../scripts/db/lib';
import { SessionConflictError, SessionService } from '@/modules/session';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  adminA: randomUUID(),
  platformAdmin: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
};
const scope = { clinicId: ids.clinicA, actorUserId: ids.adminA };

beforeAll(async () => migrate());

beforeEach(async () => {
  process.env.STAFF_SESSION_SECRET =
    'delay-hardening-test-secret-at-least-32-characters';
  await pool.query(`TRUNCATE audit_events, session_command_receipts,
    consultation_sessions, schedule_templates, doctor_clinics,
    doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id, auth_subject, display_name, platform_role) VALUES
       ($1, 'delay-admin', 'Delay Admin', NULL),
       ($2, 'delay-platform-admin', 'Platform Admin', 'platform_admin'),
       ($3, 'delay-doctor', 'Doctor', NULL)`,
    [ids.adminA, ids.platformAdmin, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id, tenant_key, name) VALUES
       ($1, 'delay-clinic-a', 'Clinic A'),
       ($2, 'delay-clinic-b', 'Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id, user_id, role)
     VALUES ($1, $2, 'clinic_admin')`,
    [ids.clinicA, ids.adminA],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id, user_id, display_name)
     VALUES ($1, $2, 'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id, doctor_id) VALUES ($1, $3), ($2, $3)`,
    [ids.clinicA, ids.clinicB, ids.doctor],
  );
});

afterAll(async () => {
  await closePool();
  await pool.end();
});

async function seedSession(
  clinicId = ids.clinicA,
  status: 'planned' | 'open' = 'planned',
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO consultation_sessions
       (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, '2026-09-20', '2026-09-20 09:00Z',
       '2026-09-20 12:00Z', $4)`,
    [id, clinicId, ids.doctor, status],
  );
  return id;
}

async function race<T>(left: () => Promise<T>, right: () => Promise<T>) {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  let arrived = 0;
  const contender = async (operation: () => Promise<T>) => {
    if (++arrived === 2) release();
    await barrier;
    return operation();
  };
  return Promise.allSettled([contender(left), contender(right)]);
}

function delayInput(
  command: 'declare_delay' | 'update_delay' | 'clear_delay',
  expectedVersion: number,
  key: string,
  minutes?: number,
) {
  return {
    command,
    expectedVersion,
    idempotencyKey: key,
    correlationId: key,
    ...(minutes === undefined ? {} : { minutes }),
  };
}

describe('session delay concurrency and idempotency hardening', () => {
  it('serializes truly concurrent update-delay and clear-delay commands', async () => {
    const id = await seedSession();
    const sessions = new SessionService(pool);
    await sessions.delay(
      scope,
      id,
      delayInput('declare_delay', 0, 'initial', 15),
    );

    const results = await race(
      () =>
        sessions.delay(scope, id, delayInput('update_delay', 1, 'update', 30)),
      () => sessions.delay(scope, id, delayInput('clear_delay', 1, 'clear')),
    );

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: expect.any(SessionConflictError),
    });
    const stored = await pool.query<{
      declared_delay_minutes: number | null;
      delay_version: number;
    }>(
      `SELECT declared_delay_minutes, delay_version
         FROM consultation_sessions WHERE id = $1`,
      [id],
    );
    expect(stored.rows[0]?.delay_version).toBe(2);
    expect([null, 30]).toContain(stored.rows[0]?.declared_delay_minutes);
  });

  it.each(['close', 'cancel'] as const)(
    'serializes delay against terminal %s and rejects later delay changes',
    async (command) => {
      const id = await seedSession(ids.clinicA, 'open');
      const sessions = new SessionService(pool);
      const results = await race(
        () =>
          sessions.delay(
            scope,
            id,
            delayInput('declare_delay', 0, `${command}-delay`, 25),
          ),
        () =>
          sessions.command(scope, id, {
            command,
            reason: command === 'cancel' ? 'clinic closure' : undefined,
            idempotencyKey: `${command}-terminal`,
            correlationId: `${command}-terminal`,
          }),
      );

      expect(
        results.filter(({ status }) => status === 'fulfilled').length,
      ).toBeGreaterThanOrEqual(1);
      expect(results[1]?.status).toBe('fulfilled');
      const stored = await pool.query<{
        status: string;
        delay_version: number;
      }>(
        'SELECT status, delay_version FROM consultation_sessions WHERE id = $1',
        [id],
      );
      expect(stored.rows[0]?.status).toBe(
        command === 'close' ? 'closed' : 'cancelled',
      );
      expect([0, 1]).toContain(stored.rows[0]?.delay_version);
      const retry = await sessions.command(scope, id, {
        command,
        reason: command === 'cancel' ? 'clinic closure' : undefined,
        idempotencyKey: `${command}-terminal`,
        correlationId: `${command}-terminal`,
      });
      expect(retry.status).toBe(command === 'close' ? 'closed' : 'cancelled');
      const terminalAudit = await pool.query(
        `SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = $2`,
        [id, `consultation_session.${command}`],
      );
      expect(terminalAudit.rows).toHaveLength(1);
      await expect(
        sessions.delay(
          scope,
          id,
          delayInput(
            'declare_delay',
            stored.rows[0]!.delay_version,
            `${command}-late`,
            10,
          ),
        ),
      ).rejects.toThrow('terminal session');
    },
  );

  it('rejects one idempotency key reused across different delay commands', async () => {
    const id = await seedSession();
    const sessions = new SessionService(pool);
    await sessions.delay(
      scope,
      id,
      delayInput('declare_delay', 0, 'shared-key', 10),
    );
    await expect(
      sessions.delay(scope, id, delayInput('clear_delay', 1, 'shared-key')),
    ).rejects.toThrow(
      'Idempotency key was already used for a different command',
    );
  });

  it('does not duplicate audit on exact retry or include patient or clinical metadata', async () => {
    const id = await seedSession();
    const sessions = new SessionService(pool);
    const input = delayInput('declare_delay', 0, 'audit-retry', 40);
    await sessions.delay(scope, id, input);
    await sessions.delay(scope, id, input);

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
       WHERE entity_id = $1 AND action = 'consultation_session.declare_delay'`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(Object.keys(audit.rows[0]!.metadata).sort()).toEqual([
      'command',
      'correlationId',
      'from',
      'idempotencyKey',
      'minutes',
      'outcome',
      'to',
      'version',
    ]);
    expect(JSON.stringify(audit.rows[0]!.metadata).toLowerCase()).not.toMatch(
      /patient|clinical|diagnos|symptom|phone|email/,
    );
  });
});

describe('delay HTTP authorization boundaries', () => {
  function request(clinicId: string, sessionId: string, authSubject?: string) {
    const cookie = authSubject
      ? `tabibi_staff_session=${createStaffSessionToken(authSubject, new Date(Date.now() + 60_000))}`
      : undefined;
    return delayRoute(
      new Request(
        `http://localhost/api/clinics/${clinicId}/sessions/${sessionId}/delay`,
        {
          method: 'POST',
          headers: {
            origin: 'http://localhost',
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify({
            command: 'declare_delay',
            minutes: 10,
            expectedVersion: 0,
          }),
        },
      ),
      { params: Promise.resolve({ clinicId, sessionId }) },
    );
  }

  it('rejects a cross-clinic session identifier on the delay route', async () => {
    const sessionId = await seedSession(ids.clinicB);
    const response = await request(ids.clinicA, sessionId, 'delay-admin');
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'conflict' });
  });

  it('rejects unauthenticated and unauthorized-role delay requests', async () => {
    const sessionId = await seedSession();
    const anonymous = await request(ids.clinicA, sessionId);
    expect(anonymous.status).toBe(401);
    const platformAdmin = await request(
      ids.clinicA,
      sessionId,
      'delay-platform-admin',
    );
    expect(platformAdmin.status).toBe(403);
    await expect(platformAdmin.json()).resolves.toMatchObject({
      error: 'forbidden',
    });
  });
});
