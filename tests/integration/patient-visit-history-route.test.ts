import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GET as visitsGet } from '@/app/api/patient/visits/route';
import { POST as signInPost } from '@/app/api/patient/session/route';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import { closePool, getPool } from '@/platform/database/pool';

// TAB-P1-04 slice 3: read-only operational visit history behind the patient session.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const SECRET = 'patient-visit-history-secret-at-least-32-chars';
const PASS = 'correct horse battery';
const A = 'leila.visits@example.test';
const B = 'karim.visits@example.test';
const URL_BASE = 'http://localhost/api/patient/visits';
const clinic: string = randomUUID();
const doctor: string = randomUUID();
let seq = 0;

const login = async (email: string) => {
  const res = await signInPost(
    new Request('http://localhost/api/patient/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ email, password: PASS }),
    }),
  );
  return `tabibi_patient_session=${/tabibi_patient_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]}`;
};
const get = (cookie: string | null, query = '') =>
  visitsGet(
    new Request(`${URL_BASE}${query}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
const userIds = new Map<string, string>();
const userId = async (email: string) => userIds.get(email)!;

/** Seeds one appointment (own record, optionally for a dependent) at `startsAt`. */
async function seedVisit(
  accountUserId: string | null,
  startsAt: Date,
  status = 'completed',
  dependentId: string | null = null,
): Promise<string> {
  seq += 1;
  const sessionId = randomUUID();
  const patientId = randomUUID();
  const entryId = randomUUID();
  const appointmentId = randomUUID();
  const end = new Date(startsAt.getTime() + 15 * 60_000);
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,$4::date,$5,$6,'planned')`,
    [
      sessionId,
      clinic,
      doctor,
      startsAt.toISOString().slice(0, 10),
      startsAt,
      end,
    ],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
       (id,clinic_id,account_user_id,private_display_name,preferred_locale)
     VALUES($1,$2,$3,'Private Name','fr')`,
    [patientId, clinic, accountUserId],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','appointment',1,$5)`,
    [entryId, clinic, sessionId, patientId, `V-${seq}`],
  );
  await pool.query(
    `INSERT INTO appointments
       (id,clinic_id,doctor_id,session_id,patient_id,queue_entry_id,status,
        scheduled_start_at,scheduled_end_at,preferred_locale,dependent_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'fr',$10)`,
    [
      appointmentId,
      clinic,
      doctor,
      sessionId,
      patientId,
      entryId,
      status,
      startsAt,
      end,
      dependentId,
    ],
  );
  return appointmentId;
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = SECRET;
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE appointments, queue_entries, patient_operational_records, patient_dependents,
       consultation_sessions, doctor_clinics, doctor_profiles, clinics,
       patient_credentials, users, staff_sign_in_rate_limit_buckets CASCADE`,
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'vh-a','Clinique Al Amal')`,
    [clinic],
  );
  const doctorUser = randomUUID();
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,$2,'Dr Amine')`,
    [doctorUser, `doc-${doctorUser}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr Amine')`,
    [doctor, doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [clinic, doctor],
  );
  for (const [email, name] of [
    [A, 'Leila'],
    [B, 'Karim'],
  ] as const) {
    const result = await registerPatientAccount(getPool(), {
      email,
      displayName: name,
      password: PASS,
    });
    if (!result.ok) throw new Error('registration failed');
    userIds.set(email, result.userId);
  }
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('patient visit history route', () => {
  it('requires a patient session', async () => {
    expect((await get(null)).status).toBe(401);
  });

  it('lists only the signed-in account visits, newest first, with the exact minimized shape', async () => {
    const a = await login(A);
    const aId = await userId(A);
    const bId = await userId(B);
    const older = await seedVisit(aId, daysAgo(30), 'cancelled');
    const newer = await seedVisit(aId, daysAgo(2), 'completed');
    await seedVisit(bId, daysAgo(1));
    await seedVisit(null, daysAgo(1));
    const body = await (await get(a)).json();
    expect(body.nextCursor).toBeNull();
    expect(
      body.visits.map((v: { appointmentId: string }) => v.appointmentId),
    ).toEqual([newer, older]);
    expect(Object.keys(body.visits[0]).sort()).toEqual([
      'appointmentId',
      'clinicId',
      'clinicName',
      'dependentId',
      'doctorDisplayName',
      'doctorId',
      'scheduledEndAt',
      'scheduledStartAt',
      'status',
    ]);
    expect(body.visits[0]).toMatchObject({
      clinicName: 'Clinique Al Amal',
      doctorDisplayName: 'Dr Amine',
      status: 'completed',
      dependentId: null,
    });
    expect(JSON.stringify(body)).not.toContain('Private Name');
    expect((await (await get(await login(B))).json()).visits).toHaveLength(1);
  });

  it('includes owned active dependent visits and excludes archived and other-account dependents', async () => {
    const a = await login(A);
    const aId = await userId(A);
    const bId = await userId(B);
    const [active, archived, foreign] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await pool.query(
      `INSERT INTO patient_dependents(id,owner_user_id,display_name,status,archived_at)
       VALUES($1,$4,'Enfant',  'active',NULL),
             ($2,$4,'Archivé','archived',now()),
             ($3,$5,'Autre',  'active',NULL)`,
      [active, archived, foreign, aId, bId],
    );
    // Dependent visits are booked on the booker's record; the dependent link decides ownership.
    const mine = await seedVisit(aId, daysAgo(3), 'confirmed', active);
    await seedVisit(aId, daysAgo(4), 'confirmed', archived);
    await seedVisit(aId, daysAgo(5), 'confirmed', foreign);
    const visits = (await (await get(a)).json()).visits;
    expect(
      visits.map((v: { appointmentId: string }) => v.appointmentId),
    ).toEqual([mine]);
    expect(visits[0].dependentId).toBe(active);
  });

  it('paginates with a stable keyset cursor and no duplicates across equal start times', async () => {
    const a = await login(A);
    const aId = await userId(A);
    const tied = daysAgo(5);
    tied.setMilliseconds(0);
    const ids = [
      await seedVisit(aId, daysAgo(1)),
      await seedVisit(aId, tied),
      await seedVisit(aId, tied),
      await seedVisit(aId, daysAgo(9)),
      await seedVisit(aId, daysAgo(10)),
    ];
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const body: {
        visits: { appointmentId: string }[];
        nextCursor: string | null;
      } = await (await get(a, q)).json();
      seen.push(...body.visits.map((v) => v.appointmentId));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('hides visits older than the retention window', async () => {
    const a = await login(A);
    const aId = await userId(A);
    await seedVisit(aId, daysAgo(24 * 31 + 5));
    const recent = await seedVisit(aId, daysAgo(10));
    expect(
      (await (await get(a)).json()).visits.map(
        (v: { appointmentId: string }) => v.appointmentId,
      ),
    ).toEqual([recent]);
  });

  it('rejects malformed limit and cursor values', async () => {
    const a = await login(A);
    for (const q of [
      '?limit=0',
      '?limit=51',
      '?limit=abc',
      '?limit=-1',
      '?cursor=not-a-cursor',
      `?cursor=${Buffer.from('2026-01-01T00:00:00.000Z|nope').toString('base64url')}`,
      '?owner=someone',
    ])
      expect((await get(a, q)).status, q).toBe(400);
  });
});
