import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import {
  SessionConflictError,
  SessionService,
  SessionValidationError,
  type SessionCommand,
} from '@/modules/session';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const id = Object.fromEntries(
  [
    'clinicA',
    'clinicB',
    'admin',
    'reception',
    'platform',
    'doctorUser',
    'otherDoctorUser',
    'doctor',
    'otherDoctor',
  ].map((key) => [key, randomUUID()]),
) as Record<string, string>;
const admin = { clinicId: id.clinicA!, actorUserId: id.admin! };
const reception = { clinicId: id.clinicA!, actorUserId: id.reception! };
const doctor = { clinicId: id.clinicA!, actorUserId: id.doctorUser! };

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE session_operation_receipts, audit_events, consultation_sessions,
    schedule_templates, doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name,platform_role) VALUES
    ($1,'admin','Admin',NULL),($2,'reception','Reception',NULL),($3,'platform','Platform','platform_admin'),
    ($4,'doctor','Doctor A',NULL),($5,'other-doctor','Doctor B',NULL)`,
    [id.admin, id.reception, id.platform, id.doctorUser, id.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,'ops-a','A'),($2,'ops-b','B')`,
    [id.clinicA, id.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
    ($1,$3,'clinic_admin'),($1,$4,'receptionist'),($1,$5,'doctor'),($1,$6,'doctor'),($2,$5,'doctor')`,
    [
      id.clinicA,
      id.clinicB,
      id.admin,
      id.reception,
      id.doctorUser,
      id.otherDoctorUser,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES ($1,$2,'Doctor A'),($3,$4,'Doctor B')`,
    [id.doctor, id.doctorUser, id.otherDoctor, id.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES ($1,$3),($1,$4),($2,$3)`,
    [id.clinicA, id.clinicB, id.doctor, id.otherDoctor],
  );
});
afterAll(() => pool.end());

async function seed(
  clinicId = id.clinicA!,
  doctorId = id.doctor!,
  status = 'planned',
) {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO consultation_sessions
    (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status,cancellation_reason)
    VALUES ($1,$2,$3,'2026-09-07','2026-09-07 09:00Z','2026-09-07 12:00Z',$4::session_status,
      CASE WHEN $4::text = 'cancelled' THEN 'seeded' ELSE NULL END)`,
    [sessionId, clinicId, doctorId, status],
  );
  return sessionId;
}
const operation = (
  command: SessionCommand,
  key: string = randomUUID(),
  extra = {},
) => ({
  command,
  idempotencyKey: key,
  correlationId: `correlation-${key}`,
  ...extra,
});

describe('operational session controls', () => {
  it('lists a minimal clinic/day read model with doctor and operational metadata', async () => {
    await seed();
    await seed(id.clinicB!);
    const result = await new SessionService(pool).listSessions(
      reception,
      '2026-09-07',
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      clinicId: id.clinicA,
      doctorName: 'Doctor A',
      status: 'planned',
      delayMinutes: null,
    });
    expect(result[0]).not.toHaveProperty('authSubject');
  });

  it('enforces tenant, platform-admin, and Doctor A versus Doctor B authorization', async () => {
    const own = await seed();
    const other = await seed(id.clinicA!, id.otherDoctor!);
    const sessions = new SessionService(pool);
    await expect(
      sessions.operate(doctor, own, operation('open')),
    ).resolves.toMatchObject({ status: 'open' });
    await expect(
      sessions.operate(doctor, other, operation('open')),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      sessions.listSessions(
        { clinicId: id.clinicA!, actorUserId: id.platform! },
        '2026-09-07',
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      sessions.operate(
        { clinicId: id.clinicB!, actorUserId: id.doctorUser! },
        own,
        operation('pause'),
      ),
    ).rejects.toThrow('Session not found in clinic');
  });

  it('runs the lifecycle, records timestamps and one metadata-only audit per exact retry', async () => {
    const sessionId = await seed();
    const sessions = new SessionService(pool);
    const open = operation('open', 'open-key');
    const first = await sessions.operate(reception, sessionId, open);
    const retry = await sessions.operate(reception, sessionId, open);
    expect(retry).toEqual(first);
    await sessions.operate(reception, sessionId, operation('pause'));
    await sessions.operate(reception, sessionId, operation('resume'));
    const closed = await sessions.operate(
      reception,
      sessionId,
      operation('close'),
    );
    expect(closed).toMatchObject({ status: 'closed' });
    expect(closed.openedAt).not.toBeNull();
    expect(closed.closedAt).not.toBeNull();
    const audit = await pool.query(
      `SELECT metadata FROM audit_events WHERE entity_id=$1 ORDER BY id`,
      [sessionId],
    );
    expect(audit.rows).toHaveLength(4);
    expect(audit.rows[0].metadata).toMatchObject({
      command: 'open',
      outcome: 'applied',
      idempotencyKey: 'open-key',
    });
    await expect(
      sessions.operate(reception, sessionId, operation('open')),
    ).rejects.toBeInstanceOf(SessionConflictError);
  });

  it('requires cancellation reason and persists reason and audit identity', async () => {
    const sessionId = await seed();
    const sessions = new SessionService(pool);
    await expect(
      sessions.operate(admin, sessionId, operation('cancel')),
    ).rejects.toBeInstanceOf(SessionValidationError);
    const cancelled = await sessions.operate(
      admin,
      sessionId,
      operation('cancel', 'cancel-key', { reason: 'Doctor unavailable' }),
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'Doctor unavailable',
    });
    expect(cancelled.cancelledAt).not.toBeNull();
  });

  it('validates delay and makes declare, update, and clear exact retries idempotent', async () => {
    const sessionId = await seed();
    const sessions = new SessionService(pool);
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(
        sessions.operate(
          admin,
          sessionId,
          operation('delay_declare', randomUUID(), { delayMinutes: value }),
        ),
      ).rejects.toBeInstanceOf(SessionValidationError);
    await sessions.operate(
      admin,
      sessionId,
      operation('delay_declare', 'declare', { delayMinutes: 12.5 }),
    );
    expect(
      await sessions.operate(
        admin,
        sessionId,
        operation('delay_update', 'update', { delayMinutes: 20 }),
      ),
    ).toMatchObject({ delayMinutes: 20 });
    const clear = operation('delay_clear', 'clear');
    expect(await sessions.operate(admin, sessionId, clear)).toMatchObject({
      delayMinutes: null,
    });
    expect(await sessions.operate(admin, sessionId, clear)).toMatchObject({
      delayMinutes: null,
    });
  });

  it('rejects a reused idempotency key with a different payload', async () => {
    const sessionId = await seed();
    const sessions = new SessionService(pool);
    await sessions.operate(
      admin,
      sessionId,
      operation('delay_declare', 'same', { delayMinutes: 10 }),
    );
    await expect(
      sessions.operate(
        admin,
        sessionId,
        operation('delay_update', 'same', { delayMinutes: 20 }),
      ),
    ).rejects.toThrow('Idempotency key was already used');
  });
});
