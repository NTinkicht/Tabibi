import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { ClinicService } from '@/modules/clinic';
import { AuthorizationError } from '@/modules/identity';
import { SchedulingService } from '@/modules/scheduling';
import { SessionConflictError, SessionService } from '@/modules/session';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });

const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  adminA: randomUUID(),
  receptionistA: randomUUID(),
  adminB: randomUUID(),
  platformAdmin: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
};

const scopeA = { clinicId: ids.clinicA, actorUserId: ids.adminA };
const scopeB = { clinicId: ids.clinicB, actorUserId: ids.adminB };

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name, platform_role) VALUES
       ($1, 'admin-a', 'Admin A', NULL),
       ($2, 'reception-a', 'Reception A', NULL),
       ($3, 'admin-b', 'Admin B', NULL),
       ($4, 'platform-admin', 'Platform Admin', 'platform_admin'),
       ($5, 'doctor', 'Doctor', NULL)`,
    [
      ids.adminA,
      ids.receptionistA,
      ids.adminB,
      ids.platformAdmin,
      ids.doctorUser,
    ],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'clinic-a', 'Clinic A'), ($2, 'clinic-b', 'Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'),
       ($2, $5, 'clinic_admin'), ($1, $6, 'doctor'), ($2, $6, 'doctor')`,
    [
      ids.clinicA,
      ids.clinicB,
      ids.adminA,
      ids.receptionistA,
      ids.adminB,
      ids.doctorUser,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $3), ($2, $3)`,
    [ids.clinicA, ids.clinicB, ids.doctor],
  );
});

afterAll(async () => pool.end());

describe('clinic and staff tenant boundaries', () => {
  it('applies Algerian locale defaults and exact clinic membership roles', async () => {
    const clinic = await new ClinicService(pool).getClinic(scopeA);
    expect(clinic).toMatchObject({
      timezone: 'Africa/Algiers',
      defaultLocale: 'ar',
      enabledLocales: ['ar', 'fr'],
      status: 'active',
    });

    await expect(
      pool.query(
        `INSERT INTO clinic_memberships (clinic_id, user_id, role)
         VALUES ($1, $2, 'platform_admin')`,
        [ids.clinicA, ids.platformAdmin],
      ),
    ).rejects.toMatchObject({ code: '22P02' });
  });

  it('does not grant platform admins or cross-clinic identifiers implicit access', async () => {
    const clinics = new ClinicService(pool);
    await expect(
      clinics.getClinic({
        clinicId: ids.clinicA,
        actorUserId: ids.platformAdmin,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    await expect(
      clinics.updateClinic(scopeA, {
        name: 'Attempted cross-tenant update',
        status: 'inactive',
      }),
    ).resolves.toMatchObject({ id: ids.clinicA });
    const clinicB = await clinics.getClinic(scopeB);
    expect(clinicB.name).toBe('Clinic B');
  });

  it('requires clinic-admin permission for membership mutation and audits it', async () => {
    const clinics = new ClinicService(pool);
    await expect(
      clinics.setMembership(
        { clinicId: ids.clinicA, actorUserId: ids.receptionistA },
        ids.platformAdmin,
        'receptionist',
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await clinics.setMembership(scopeA, ids.platformAdmin, 'receptionist');
    const audit = await pool.query<{ metadata: { role: string } }>(
      `SELECT metadata FROM audit_events WHERE clinic_id = $1 AND action = 'membership.set'`,
      [ids.clinicA],
    );
    expect(audit.rows[0]?.metadata).toEqual({ role: 'receptionist' });
  });
});

describe('deterministic schedule generation', () => {
  it('generates seven days idempotently and prevents concurrent duplicates', async () => {
    const schedules = new SchedulingService(pool);
    const template = await schedules.createTemplate(scopeA, {
      doctorId: ids.doctor,
      weekday: 1,
      localStartTime: '09:00',
      localEndTime: '12:00',
      occurrenceIndex: 0,
    });
    const attempts = await Promise.all([
      schedules.generateSessions(scopeA, {
        doctorId: ids.doctor,
        startDate: '2026-09-07',
      }),
      schedules.generateSessions(scopeA, {
        doctorId: ids.doctor,
        startDate: '2026-09-07',
      }),
    ]);
    expect(attempts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(
      await schedules.generateSessions(scopeA, {
        doctorId: ids.doctor,
        startDate: '2026-09-07',
      }),
    ).toBe(0);

    const rows = await pool.query<{
      id: string;
      template_id: string;
      starts_at: Date;
    }>(
      `SELECT id, template_id, starts_at FROM consultation_sessions WHERE clinic_id = $1`,
      [ids.clinicA],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.template_id).toBe(template.id);
    expect(rows.rows[0]?.starts_at.toISOString()).toBe(
      '2026-09-07T08:00:00.000Z',
    );
  });
});

async function seedSession(
  clinicId: string,
  date: string,
  status: 'planned' | 'paused' = 'planned',
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO consultation_sessions
       (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, $4, $4::date + time '09:00', $4::date + time '12:00', $5)`,
    [id, clinicId, ids.doctor, date, status],
  );
  return id;
}

async function race<T>(left: () => Promise<T>, right: () => Promise<T>) {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  let arrived = 0;
  const contender = async (operation: () => Promise<T>) => {
    arrived += 1;
    if (arrived === 2) release();
    await barrier;
    return operation();
  };
  return Promise.allSettled([contender(left), contender(right)]);
}

describe('doctor-global session lifecycle invariant', () => {
  it('allows exactly one cross-clinic open/open contender', async () => {
    const sessions = new SessionService(pool);
    const a = await seedSession(ids.clinicA, '2026-09-07');
    const b = await seedSession(ids.clinicB, '2026-09-08');
    const results = await race(
      () => sessions.transition(scopeA, a, 'open'),
      () => sessions.transition(scopeB, b, 'open'),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.any(SessionConflictError),
    });
  });

  it('allows exactly one cross-clinic open/resume contender', async () => {
    const sessions = new SessionService(pool);
    const paused = await seedSession(ids.clinicA, '2026-09-07', 'paused');
    const planned = await seedSession(ids.clinicB, '2026-09-08');
    const results = await race(
      () => sessions.transition(scopeA, paused, 'open'),
      () => sessions.transition(scopeB, planned, 'open'),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const open = await pool.query(
      `SELECT id FROM consultation_sessions WHERE doctor_id = $1 AND status = 'open'`,
      [ids.doctor],
    );
    expect(open.rows).toHaveLength(1);
  });

  it('rejects cross-clinic session IDs and terminal-state transitions', async () => {
    const sessions = new SessionService(pool);
    const session = await seedSession(ids.clinicB, '2026-09-08');
    await expect(sessions.transition(scopeA, session, 'open')).rejects.toThrow(
      'Session not found in clinic',
    );
    await sessions.transition(scopeB, session, 'cancelled');
    await expect(sessions.transition(scopeB, session, 'open')).rejects.toThrow(
      'Cannot transition session from cancelled to open',
    );
  });
});

describe('reception session operations', () => {
  it('creates manual sessions with exact-retry idempotency and audits metadata only', async () => {
    const sessions = new SessionService(pool);
    const input = {
      doctorId: ids.doctor,
      serviceDate: '2026-09-10',
      startsAt: new Date('2026-09-10T08:00:00Z'),
      endsAt: new Date('2026-09-10T11:00:00Z'),
      idempotencyKey: 'manual-1',
      correlationId: 'request-manual-1',
    };
    const created = await sessions.createManual(
      { clinicId: ids.clinicA, actorUserId: ids.receptionistA },
      input,
    );
    const retry = await sessions.createManual(
      { clinicId: ids.clinicA, actorUserId: ids.receptionistA },
      input,
    );
    expect(retry.id).toBe(created.id);
    await expect(
      sessions.createManual(
        { clinicId: ids.clinicA, actorUserId: ids.receptionistA },
        {
          ...input,
          endsAt: new Date('2026-09-10T12:00:00Z'),
        },
      ),
    ).rejects.toThrow('different command');
    expect(
      (
        await pool.query(`SELECT 1 FROM audit_events WHERE entity_id=$1`, [
          created.id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('makes lifecycle retries stable and records command identities without clinical data', async () => {
    const id = await seedSession(ids.clinicA, '2026-09-11');
    const sessions = new SessionService(pool);
    const input = {
      command: 'open' as const,
      idempotencyKey: 'open-1',
      correlationId: 'request-open-1',
    };
    const opened = await sessions.command(scopeA, id, input);
    const retry = await sessions.command(scopeA, id, input);
    expect(retry.status).toBe('open');
    expect(retry.openedAt).toEqual(opened.openedAt);
    await sessions.command(scopeA, id, {
      command: 'pause',
      idempotencyKey: 'pause-1',
      correlationId: 'request-pause-1',
    });
    await sessions.command(scopeA, id, {
      command: 'resume',
      idempotencyKey: 'resume-1',
      correlationId: 'request-resume-1',
    });
    await sessions.command(scopeA, id, {
      command: 'close',
      idempotencyKey: 'close-1',
      correlationId: 'request-close-1',
    });
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE entity_id=$1 ORDER BY id`,
      [id],
    );
    expect(audit.rows).toHaveLength(4);
    expect(audit.rows[0]?.metadata).toMatchObject({
      command: 'open',
      outcome: 'applied',
      correlationId: 'request-open-1',
      idempotencyKey: 'open-1',
    });
    expect(JSON.stringify(audit.rows)).not.toMatch(
      /patient|diagnosis|treatment/i,
    );
  });

  it('re-authorizes on every idempotent retry and rejects replay after membership revocation', async () => {
    const id = await seedSession(ids.clinicA, '2026-09-15');
    const sessions = new SessionService(pool);
    const receptionScope = {
      clinicId: ids.clinicA,
      actorUserId: ids.receptionistA,
    };
    const input = {
      command: 'open' as const,
      idempotencyKey: 'revoke-retry-1',
      correlationId: 'revoke-retry-1',
    };
    const opened = await sessions.command(receptionScope, id, input);
    expect(opened.status).toBe('open');
    const retry = await sessions.command(receptionScope, id, input);
    expect(retry.status).toBe('open');
    await pool.query(
      `DELETE FROM clinic_memberships WHERE clinic_id = $1 AND user_id = $2`,
      [ids.clinicA, ids.receptionistA],
    );
    await expect(
      sessions.command(receptionScope, id, input),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const audit = await pool.query(
      `SELECT 1 FROM audit_events WHERE entity_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('rejects a manual session whose serviceDate does not match the clinic-local date of startsAt', async () => {
    const sessions = new SessionService(pool);
    await expect(
      sessions.createManual(
        { clinicId: ids.clinicA, actorUserId: ids.receptionistA },
        {
          doctorId: ids.doctor,
          serviceDate: '2026-09-09',
          startsAt: new Date('2026-09-10T08:00:00Z'),
          endsAt: new Date('2026-09-10T11:00:00Z'),
          idempotencyKey: 'mismatched-service-date',
          correlationId: 'mismatched-service-date',
        },
      ),
    ).rejects.toThrow('serviceDate must match the clinic-local date');
    expect(
      (
        await pool.query(
          `SELECT 1 FROM consultation_sessions WHERE service_date IN ('2026-09-09','2026-09-10') AND clinic_id = $1`,
          [ids.clinicA],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('validates, versions, updates, clears, and idempotently retries delay declarations', async () => {
    const id = await seedSession(ids.clinicA, '2026-09-12');
    const sessions = new SessionService(pool);
    for (const minutes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(
        sessions.delay(scopeA, id, {
          command: 'declare_delay',
          minutes,
          expectedVersion: 0,
          idempotencyKey: `bad-${String(minutes)}`,
          correlationId: 'bad',
        }),
      ).rejects.toBeInstanceOf(Error);
    }
    const declared = await sessions.delay(scopeA, id, {
      command: 'declare_delay',
      minutes: 20,
      expectedVersion: 0,
      idempotencyKey: 'delay-1',
      correlationId: 'delay-1',
    });
    expect(declared).toMatchObject({
      declaredDelayMinutes: 20,
      delayVersion: 1,
    });
    const retry = await sessions.delay(scopeA, id, {
      command: 'declare_delay',
      minutes: 20,
      expectedVersion: 0,
      idempotencyKey: 'delay-1',
      correlationId: 'delay-1',
    });
    expect(retry).toMatchObject({ declaredDelayMinutes: 20, delayVersion: 1 });
    await expect(
      sessions.delay(scopeA, id, {
        command: 'clear_delay',
        expectedVersion: 1,
        idempotencyKey: 'delay-1',
        correlationId: 'conflicting-reuse',
      }),
    ).rejects.toThrow('Idempotency key was reused with a different request');
    await expect(
      sessions.delay(scopeA, id, {
        command: 'update_delay',
        minutes: 30,
        expectedVersion: 0,
        idempotencyKey: 'stale',
        correlationId: 'stale',
      }),
    ).rejects.toThrow('stale');
    const updated = await sessions.delay(scopeA, id, {
      command: 'update_delay',
      minutes: 30,
      expectedVersion: 1,
      idempotencyKey: 'delay-2',
      correlationId: 'delay-2',
    });
    const cleared = await sessions.delay(scopeA, id, {
      command: 'clear_delay',
      expectedVersion: updated.delayVersion,
      idempotencyKey: 'delay-3',
      correlationId: 'delay-3',
    });
    expect(cleared).toMatchObject({
      declaredDelayMinutes: null,
      delayVersion: 3,
      delayUpdatedAt: null,
    });
    const audits = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
       WHERE clinic_id=$1 AND entity_id=$2 AND action LIKE 'consultation_session.%delay'
       ORDER BY created_at`,
      [ids.clinicA, id],
    );
    expect(audits.rows).toHaveLength(3);
    for (const { metadata } of audits.rows) {
      expect(metadata).not.toHaveProperty('patientId');
      expect(metadata).not.toHaveProperty('patient');
      expect(metadata).not.toHaveProperty('reason');
      expect(metadata).not.toHaveProperty('clinical');
    }
  });

  it('enforces delay clinic and operational-role boundaries', async () => {
    const id = await seedSession(ids.clinicA, '2026-09-17');
    const sessions = new SessionService(pool);
    const input = {
      command: 'declare_delay' as const,
      minutes: 10,
      expectedVersion: 0,
      idempotencyKey: 'scoped-delay',
      correlationId: 'scoped-delay',
    };
    await expect(sessions.delay(scopeB, id, input)).rejects.toThrow(
      'Session not found in clinic',
    );
    await expect(
      sessions.delay(
        { clinicId: ids.clinicA, actorUserId: ids.platformAdmin },
        id,
        input,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      sessions.delay(
        { clinicId: ids.clinicA, actorUserId: ids.receptionistA },
        id,
        input,
      ),
    ).resolves.toMatchObject({ declaredDelayMinutes: 10, delayVersion: 1 });
  });

  it('serializes concurrent delay update and clear with a stale loser', async () => {
    const id = await seedSession(ids.clinicA, '2026-09-13');
    const sessions = new SessionService(pool);
    await sessions.delay(scopeA, id, {
      command: 'declare_delay',
      minutes: 20,
      expectedVersion: 0,
      idempotencyKey: 'race-declare',
      correlationId: 'race-declare',
    });
    const results = await race(
      () =>
        sessions.delay(scopeA, id, {
          command: 'update_delay',
          minutes: 30,
          expectedVersion: 1,
          idempotencyKey: 'race-update',
          correlationId: 'race-update',
        }),
      () =>
        sessions.delay(scopeA, id, {
          command: 'clear_delay',
          expectedVersion: 1,
          idempotencyKey: 'race-clear',
          correlationId: 'race-clear',
        }),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      reason: expect.any(SessionConflictError),
    });
  });

  it.each(['close', 'cancel'] as const)(
    'serializes delay declaration against %s without changing terminal state',
    async (command) => {
      const id = await seedSession(
        ids.clinicA,
        `2026-09-${command === 'close' ? '15' : '16'}`,
      );
      const sessions = new SessionService(pool);
      await sessions.command(scopeA, id, {
        command: 'open',
        idempotencyKey: `${command}-open`,
        correlationId: `${command}-open`,
      });
      const results = await race(
        () =>
          sessions.delay(scopeA, id, {
            command: 'declare_delay',
            minutes: 15,
            expectedVersion: 0,
            idempotencyKey: `${command}-delay`,
            correlationId: `${command}-delay`,
          }),
        () =>
          sessions.command(scopeA, id, {
            command,
            reason: command === 'cancel' ? 'Clinic closed early' : undefined,
            idempotencyKey: `${command}-terminal`,
            correlationId: `${command}-terminal`,
          }),
      );
      expect(results.some((result) => result.status === 'fulfilled')).toBe(
        true,
      );
      const row = await pool.query<{ status: string }>(
        'SELECT status FROM consultation_sessions WHERE id=$1',
        [id],
      );
      expect(row.rows[0]?.status).toBe(
        command === 'close' ? 'closed' : 'cancelled',
      );
      await expect(
        sessions.delay(scopeA, id, {
          command: 'update_delay',
          minutes: 25,
          expectedVersion: 1,
          idempotencyKey: `${command}-after-terminal`,
          correlationId: `${command}-after-terminal`,
        }),
      ).rejects.toThrow('terminal session');
    },
  );

  it('serializes competing lifecycle commands and commits one winner', async () => {
    const id = await seedSession(ids.clinicA, '2026-09-14');
    const sessions = new SessionService(pool);
    await sessions.command(scopeA, id, {
      command: 'open',
      idempotencyKey: 'race-open',
      correlationId: 'race-open',
    });
    const results = await race(
      () =>
        sessions.command(scopeA, id, {
          command: 'cancel',
          reason: 'competing cancellation',
          idempotencyKey: 'race-cancel',
          correlationId: 'race-cancel',
        }),
      () =>
        sessions.command(scopeA, id, {
          command: 'close',
          idempotencyKey: 'race-close',
          correlationId: 'race-close',
        }),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('limits doctors to their own session listing and platform admins to no operational access', async () => {
    const otherUser = randomUUID(),
      otherDoctor = randomUUID();
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'other-doctor','Other Doctor')`,
      [otherUser],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'doctor')`,
      [ids.clinicA, otherUser],
    );
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Other Doctor')`,
      [otherDoctor, otherUser],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [ids.clinicA, otherDoctor],
    );
    await seedSession(ids.clinicA, '2026-09-13');
    await pool.query(
      `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at) VALUES($1,$2,$3,'2026-09-13','2026-09-13 13:00Z','2026-09-13 15:00Z')`,
      [randomUUID(), ids.clinicA, otherDoctor],
    );
    const sessions = new SessionService(pool);
    expect(
      await sessions.listSessions(
        { clinicId: ids.clinicA, actorUserId: ids.doctorUser },
        '2026-09-13',
      ),
    ).toHaveLength(1);
    await expect(
      sessions.listSessions(
        { clinicId: ids.clinicA, actorUserId: ids.platformAdmin },
        '2026-09-13',
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
