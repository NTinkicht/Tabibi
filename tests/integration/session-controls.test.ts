import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import {
  SessionConflictError,
  SessionService,
  SessionValidationError,
} from '@/modules/session';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const id = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  reception: randomUUID(),
  admin: randomUUID(),
  platform: randomUUID(),
  doctorUserA: randomUUID(),
  doctorUserB: randomUUID(),
  doctorA: randomUUID(),
  doctorB: randomUUID(),
};
const reception = { clinicId: id.clinicA, actorUserId: id.reception };
const doctorA = { clinicId: id.clinicA, actorUserId: id.doctorUserA };

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE session_command_receipts, audit_events, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id,auth_subject,display_name,platform_role) VALUES
    ($1,'r','Reception',NULL),($2,'admin','Admin',NULL),($3,'platform','Platform','platform_admin'),
    ($4,'doctor-a','Doctor A',NULL),($5,'doctor-b','Doctor B',NULL)`,
    [id.reception, id.admin, id.platform, id.doctorUserA, id.doctorUserB],
  );
  await pool.query(
    `INSERT INTO clinics (id,tenant_key,name) VALUES ($1,'controls-a','A'),($2,'controls-b','B')`,
    [id.clinicA, id.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id,user_id,role) VALUES
    ($1,$3,'receptionist'),($1,$4,'clinic_admin'),($1,$5,'doctor'),($1,$6,'doctor'),($2,$5,'doctor')`,
    [
      id.clinicA,
      id.clinicB,
      id.reception,
      id.admin,
      id.doctorUserA,
      id.doctorUserB,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id,user_id,display_name) VALUES ($1,$2,'Doctor A'),($3,$4,'Doctor B')`,
    [id.doctorA, id.doctorUserA, id.doctorB, id.doctorUserB],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id,doctor_id) VALUES ($1,$3),($1,$4),($2,$3)`,
    [id.clinicA, id.clinicB, id.doctorA, id.doctorB],
  );
});
afterAll(() => pool.end());

async function seed(
  doctorId = id.doctorA,
  status = 'planned',
  clinicId = id.clinicA,
) {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO consultation_sessions
    (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
    VALUES ($1,$2,$3,'2026-09-07','2026-09-07 09:00Z','2026-09-07 12:00Z',$4)`,
    [sessionId, clinicId, doctorId, status],
  );
  return sessionId;
}
const meta = (
  command: 'open' | 'pause' | 'resume' | 'close' | 'cancel',
  key: string,
  reason?: string,
) => ({
  command,
  idempotencyKey: key,
  correlationId: `request:${key}`,
  reason,
});

describe('operational session controls', () => {
  it('returns the minimal clinic/day read model with doctor and operational metadata', async () => {
    const sessionId = await seed();
    const result = await new SessionService(pool).listSessions(
      reception,
      '2026-09-07',
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: sessionId,
        doctorName: 'Doctor A',
        status: 'planned',
        openedAt: null,
        closedAt: null,
        delayMinutes: null,
      }),
    ]);
    expect(Object.keys(result[0]!)).not.toContain('notes');
  });

  it('runs pause/resume/close, persists timestamps/audits, and makes exact retries idempotent', async () => {
    const service = new SessionService(pool);
    const sessionId = await seed();
    const opened = await service.command(
      reception,
      sessionId,
      meta('open', 'open-1'),
    );
    expect(
      (await service.command(reception, sessionId, meta('open', 'open-1'))).id,
    ).toBe(opened.id);
    await service.command(reception, sessionId, meta('pause', 'pause-1'));
    await service.command(reception, sessionId, meta('resume', 'resume-1'));
    const closed = await service.command(
      reception,
      sessionId,
      meta('close', 'close-1'),
    );
    expect(closed).toMatchObject({ status: 'closed' });
    expect(closed.openedAt).toBeTruthy();
    expect(closed.closedAt).toBeTruthy();
    expect(
      (
        await pool.query(`SELECT * FROM audit_events WHERE entity_id=$1`, [
          sessionId,
        ])
      ).rows,
    ).toHaveLength(4);
    await expect(
      service.command(reception, sessionId, meta('close', 'different-key')),
    ).rejects.toBeInstanceOf(SessionConflictError);
  });

  it('requires cancellation reason and persists it without clinical data', async () => {
    const service = new SessionService(pool);
    const sessionId = await seed();
    await expect(
      service.command(reception, sessionId, meta('cancel', 'cancel-bad')),
    ).rejects.toBeInstanceOf(SessionValidationError);
    await service.command(
      reception,
      sessionId,
      meta('cancel', 'cancel-ok', 'doctor unavailable'),
    );
    const audit = await pool.query<{ metadata: Record<string, string> }>(
      `SELECT metadata FROM audit_events WHERE entity_id=$1`,
      [sessionId],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      reason: 'doctor unavailable',
      outcome: 'applied',
      idempotencyKey: 'cancel-ok',
    });
  });

  it('validates delay declare/update/clear and keeps clear idempotent', async () => {
    const service = new SessionService(pool);
    const sessionId = await seed();
    for (const minutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(
        service.delay(reception, sessionId, {
          command: 'delay.declare',
          minutes,
          idempotencyKey: `bad:${String(minutes)}`,
          correlationId: 'bad',
        }),
      ).rejects.toBeInstanceOf(SessionValidationError);
    await service.delay(reception, sessionId, {
      command: 'delay.declare',
      minutes: 15,
      idempotencyKey: 'delay-1',
      correlationId: 'd1',
    });
    await service.delay(reception, sessionId, {
      command: 'delay.update',
      minutes: 25,
      idempotencyKey: 'delay-2',
      correlationId: 'd2',
    });
    const clear = {
      command: 'delay.clear' as const,
      idempotencyKey: 'delay-3',
      correlationId: 'd3',
    };
    expect(
      (await service.delay(reception, sessionId, clear)).delayMinutes,
    ).toBeNull();
    expect(
      (await service.delay(reception, sessionId, clear)).delayMinutes,
    ).toBeNull();
  });

  it('isolates tenants, platform admins, and Doctor A from Doctor B', async () => {
    const service = new SessionService(pool);
    const b = await seed(id.doctorB);
    await expect(
      service.command(doctorA, b, meta('open', 'wrong-doctor')),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      service.listSessions(
        { clinicId: id.clinicA, actorUserId: id.platform },
        '2026-09-07',
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      service.command(
        { clinicId: id.clinicB, actorUserId: id.doctorUserA },
        b,
        meta('open', 'wrong-clinic'),
      ),
    ).rejects.toThrow('Session not found');
  });

  it('rejects conflicting reuse of an idempotency identity', async () => {
    const service = new SessionService(pool);
    const sessionId = await seed();
    await service.command(reception, sessionId, meta('open', 'same-key'));
    await expect(
      service.command(reception, sessionId, meta('pause', 'same-key')),
    ).rejects.toThrow('different command');
  });
});
