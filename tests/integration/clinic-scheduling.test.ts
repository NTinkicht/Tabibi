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
