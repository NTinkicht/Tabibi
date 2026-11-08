import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { ClinicService } from '@/modules/clinic';
import { AuthorizationError } from '@/modules/identity';
import { SchedulingService } from '@/modules/scheduling';
import { SessionService } from '@/modules/session';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import { DELETE as removeMember } from '@/app/api/clinics/[clinicId]/memberships/[userId]/route';
import { GET as listSessions } from '@/app/api/clinics/[clinicId]/sessions/route';
import { GET as bookableSessions } from '@/app/api/public/bookable-sessions/route';
import { GET as discovery } from '@/app/api/public/discovery/route';
import { POST as book } from '@/app/api/public/bookings/route';

// Gap register G-19 (TAB-P1-07): a clinic_admin can remove a person's access
// to the clinic; access ends on the next request, the last admin is kept, and
// a removed doctor leaves public discovery, bookable sessions and new bookings.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ORIGIN = 'http://localhost';
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  adminA1: randomUUID(),
  adminA2: randomUUID(),
  receptionistA: randomUUID(),
  doctorA: randomUUID(),
  adminB: randomUUID(),
  profileA: randomUUID(),
  session: randomUUID(),
  template: randomUUID(),
};
const subjects = {
  adminA1: 'rm-admin-a1',
  adminA2: 'rm-admin-a2',
  receptionistA: 'rm-reception-a',
  doctorA: 'rm-doctor-a',
  adminB: 'rm-admin-b',
};

async function cookie(subject: string): Promise<string> {
  const token = await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  );
  return `tabibi_staff_session=${token}`;
}

async function remove(
  actor: string,
  userId: string,
  clinicId = ids.clinicA,
): Promise<number> {
  const response = await removeMember(
    new Request(`${ORIGIN}/api/clinics/${clinicId}/memberships/${userId}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, cookie: await cookie(actor) },
    }),
    { params: Promise.resolve({ clinicId, userId }) },
  );
  return response.status;
}

async function sessionsStatus(actor: string): Promise<number> {
  const response = await listSessions(
    new Request(
      `${ORIGIN}/api/clinics/${ids.clinicA}/sessions?date=2001-01-01`,
      { headers: { origin: ORIGIN, cookie: await cookie(actor) } },
    ),
    { params: Promise.resolve({ clinicId: ids.clinicA }) },
  );
  return response.status;
}

type Bookable = {
  clinics: Array<{
    name: string;
    doctors: Array<{
      displayName: string;
      sessions: Array<{ selectionReference: string }>;
    }>;
  }>;
};
type Discovered = {
  clinics: Array<{ name: string; doctors: Array<{ displayName: string }> }>;
};

async function publicBookable(): Promise<Bookable> {
  const response = await bookableSessions(
    new Request(`${ORIGIN}/api/public/bookable-sessions`),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Bookable;
}

async function publicDiscovery(query = ''): Promise<Discovered> {
  const response = await discovery(
    new Request(`${ORIGIN}/api/public/discovery${query}`),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Discovered;
}

function doctorNames(
  clinics: Array<{ name: string; doctors: Array<{ displayName: string }> }>,
): string[] {
  return clinics
    .filter((clinic) => clinic.name === 'RM Clinic A')
    .flatMap((clinic) => clinic.doctors.map((doctor) => doctor.displayName));
}

async function auditCount(action: string, userId: string): Promise<number> {
  const r = await pool.query(
    `SELECT 1 FROM audit_events WHERE action = $1 AND entity_id = $2`,
    [action, userId],
  );
  return r.rowCount ?? 0;
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'staff-membership-removal-secret-at-least-32-chars';
  await migrate();
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, queue_command_receipts,
       queue_registration_receipts, queue_entries, patient_operational_records,
       session_command_receipts, consultation_sessions, schedule_templates,
       clinic_memberships, doctor_clinics, doctor_profiles, clinics, users CASCADE`,
  );
  for (const [key, subject] of Object.entries(subjects))
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [ids[key as keyof typeof subjects], subject],
    );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'rm-a', 'RM Clinic A'), ($2, 'rm-b', 'RM Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'clinic_admin'), ($1, $5, 'receptionist'),
       ($1, $6, 'doctor'), ($2, $7, 'clinic_admin')`,
    [
      ids.clinicA,
      ids.clinicB,
      ids.adminA1,
      ids.adminA2,
      ids.receptionistA,
      ids.doctorA,
      ids.adminB,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Dr RM Leaving')`,
    [ids.profileA, ids.doctorA],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [ids.clinicA, ids.profileA],
  );
  await pool.query(
    `INSERT INTO consultation_sessions (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, CURRENT_DATE + 2, CURRENT_DATE + 2 + time '09:00', CURRENT_DATE + 2 + time '12:00', 'planned')`,
    [ids.session, ids.clinicA, ids.profileA],
  );
  await pool.query(
    `INSERT INTO schedule_templates (id, clinic_id, doctor_id, weekday, local_start_time, local_end_time, occurrence_index, active)
     VALUES ($1, $2, $3, 1, '14:00', '17:00', 0, true)`,
    [ids.template, ids.clinicA, ids.profileA],
  );
});

async function bookWith(ref: string): Promise<number> {
  const response = await book(
    new Request(`${ORIGIN}/api/public/bookings`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': `rm-book-${randomUUID()}`,
      },
      body: JSON.stringify({
        selectionReference: ref,
        privateDisplayName: 'Racing Patient',
        preferredLocale: 'fr',
        contactPhone: '0555000111',
        contactPreference: 'phone',
      }),
    }),
  );
  return response.status;
}

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('staff membership removal (G-19)', () => {
  it('non-admins and other clinics cannot remove members, and nothing changes', async () => {
    expect(await remove(subjects.receptionistA, ids.doctorA)).toBe(403);
    expect(await remove(subjects.doctorA, ids.receptionistA)).toBe(403);
    expect(await remove(subjects.adminB, ids.receptionistA)).toBe(403);
    // Through the other clinic's own path: not a member there → 404, no change.
    expect(await remove(subjects.adminB, ids.receptionistA, ids.clinicB)).toBe(
      404,
    );
    expect(await remove(subjects.adminA1, randomUUID())).toBe(404);
    expect(await remove(subjects.adminA1, 'not-a-uuid')).toBe(404);
    expect(await sessionsStatus(subjects.receptionistA)).toBe(200);
  });

  it('an admin removes a receptionist; access ends on the next request and is audited', async () => {
    expect(await remove(subjects.adminA1, ids.receptionistA)).toBe(200);
    expect(await sessionsStatus(subjects.receptionistA)).toBe(403);
    expect(await auditCount('membership.removed', ids.receptionistA)).toBe(1);
    expect(await remove(subjects.adminA1, ids.receptionistA)).toBe(404);
  });

  it('a removed doctor leaves discovery, bookable sessions and new bookings', async () => {
    const before = await publicBookable();
    const ref = before.clinics
      .find((clinic) => clinic.name === 'RM Clinic A')
      ?.doctors.find((doctor) => doctor.displayName === 'Dr RM Leaving')
      ?.sessions[0]?.selectionReference;
    expect(ref).toBeTruthy();
    expect(doctorNames((await publicDiscovery()).clinics)).toContain(
      'Dr RM Leaving',
    );

    expect(await remove(subjects.adminA1, ids.doctorA)).toBe(200);
    expect(await sessionsStatus(subjects.doctorA)).toBe(403);

    expect(doctorNames((await publicBookable()).clinics)).not.toContain(
      'Dr RM Leaving',
    );
    expect(doctorNames((await publicDiscovery()).clinics)).not.toContain(
      'Dr RM Leaving',
    );
    expect(
      doctorNames((await publicDiscovery('?available=true')).clinics),
    ).not.toContain('Dr RM Leaving');

    const booking = await book(
      new Request(`${ORIGIN}/api/public/bookings`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': `rm-book-${randomUUID()}`,
        },
        body: JSON.stringify({
          selectionReference: ref,
          privateDisplayName: 'Late Patient',
          preferredLocale: 'fr',
          contactPhone: '0555000111',
          contactPreference: 'phone',
        }),
      }),
    );
    expect(booking.status).not.toBe(201);
    const entries = await pool.query(
      `SELECT 1 FROM queue_entries WHERE session_id = $1`,
      [ids.session],
    );
    expect(entries.rowCount).toBe(0);
    // History is kept: the association and the session still exist.
    const association = await pool.query(
      `SELECT 1 FROM doctor_clinics WHERE doctor_id = $1`,
      [ids.profileA],
    );
    expect(association.rowCount).toBe(1);

    // Staff side: the departed doctor leaves the clinic's doctor list and no
    // new session can be planned for them.
    const adminScope = { actorUserId: ids.adminA1, clinicId: ids.clinicA };
    const staffDoctors = await new ClinicService(pool).listDoctors(adminScope);
    expect(staffDoctors.map((doctor) => doctor.id)).not.toContain(ids.profileA);
    const day = new Date(Date.now() + 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await expect(
      new SessionService(pool).createManual(adminScope, {
        doctorId: ids.profileA,
        serviceDate: day,
        startsAt: new Date(`${day}T13:00:00Z`),
        endsAt: new Date(`${day}T15:00:00Z`),
        idempotencyKey: `rm-session-${randomUUID()}`,
        correlationId: 'rm-session',
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // The kept weekly template neither generates sessions nor can be extended.
    const scheduling = new SchedulingService(pool);
    const sessionsBefore = await pool.query(
      `SELECT 1 FROM consultation_sessions WHERE doctor_id = $1`,
      [ids.profileA],
    );
    await expect(
      scheduling.generateSessions(adminScope, {
        doctorId: ids.profileA,
        startDate: day,
        daysAhead: 14,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      scheduling.createTemplate(adminScope, {
        doctorId: ids.profileA,
        weekday: 2,
        localStartTime: '09:00',
        localEndTime: '12:00',
        occurrenceIndex: 0,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const sessionsAfter = await pool.query(
      `SELECT 1 FROM consultation_sessions WHERE doctor_id = $1`,
      [ids.profileA],
    );
    expect(sessionsAfter.rowCount).toBe(sessionsBefore.rowCount);
  });

  it('re-adding the doctor relists them; changing their role away from doctor delists them again', async () => {
    const service = new ClinicService(pool);
    const scope = { actorUserId: ids.adminA1, clinicId: ids.clinicA };
    await service.setMembership(scope, ids.doctorA, 'receptionist');
    expect(doctorNames((await publicDiscovery()).clinics)).not.toContain(
      'Dr RM Leaving',
    );
    const added = await service.addDoctor(scope, {
      userId: ids.doctorA,
      displayName: 'Dr RM Leaving',
    });
    expect(added.changed).toBe(true);
    expect(doctorNames((await publicDiscovery()).clinics)).toContain(
      'Dr RM Leaving',
    );
    expect(doctorNames((await publicBookable()).clinics)).toContain(
      'Dr RM Leaving',
    );

    await service.setMembership(scope, ids.doctorA, 'receptionist');
    expect(doctorNames((await publicDiscovery()).clinics)).not.toContain(
      'Dr RM Leaving',
    );
    expect(doctorNames((await publicBookable()).clinics)).not.toContain(
      'Dr RM Leaving',
    );
    const departed = await pool.query<{ departed: boolean }>(
      `SELECT departed_at IS NOT NULL AS departed FROM doctor_clinics WHERE doctor_id = $1`,
      [ids.profileA],
    );
    expect(departed.rows).toEqual([{ departed: true }]);

    await service.setMembership(scope, ids.doctorA, 'doctor');
    expect(doctorNames((await publicDiscovery()).clinics)).toContain(
      'Dr RM Leaving',
    );
  });

  it('a booking waiting on a concurrent departure is refused once the departure commits', async () => {
    const ref = (await publicBookable()).clinics
      .find((clinic) => clinic.name === 'RM Clinic A')
      ?.doctors.find((doctor) => doctor.displayName === 'Dr RM Leaving')
      ?.sessions[0]?.selectionReference;
    expect(ref).toBeTruthy();
    const departing = await pool.connect();
    try {
      await departing.query('BEGIN');
      await departing.query(
        `UPDATE doctor_clinics SET departed_at = now() WHERE clinic_id = $1 AND doctor_id = $2`,
        [ids.clinicA, ids.profileA],
      );
      const booking = bookWith(ref!);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await departing.query('COMMIT');
      expect(await booking).not.toBe(201);
    } finally {
      departing.release();
    }
    const entries = await pool.query(
      `SELECT 1 FROM queue_entries WHERE session_id = $1`,
      [ids.session],
    );
    expect(entries.rowCount).toBe(0);
  });

  it('the last clinic admin cannot be removed', async () => {
    expect(await remove(subjects.adminA2, ids.adminA1)).toBe(200);
    expect(await remove(subjects.adminA2, ids.adminA2)).toBe(409);
    expect(await sessionsStatus(subjects.adminA2)).toBe(200);
  });
});
