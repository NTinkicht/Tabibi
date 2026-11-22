import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GET as listGet } from '@/app/api/patient/saved-doctors/route';
import {
  DELETE as removeDelete,
  PUT as savePut,
} from '@/app/api/patient/saved-doctors/[clinicId]/[doctorId]/route';
import { POST as signInPost } from '@/app/api/patient/session/route';
import { registerPatientAccount } from '@/modules/identity/patient-credentials';
import { SAVED_DOCTOR_LIMIT } from '@/modules/saved-doctor';
import { closePool, getPool } from '@/platform/database/pool';

// TAB-P1-04 slice 1: saved doctors behind the patient session.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const SECRET = 'patient-saved-doctors-secret-at-least-32-chars';
const PASS = 'correct horse battery';
const A = 'leila.saved@example.test';
const B = 'karim.saved@example.test';
const BASE = 'http://localhost/api/patient/saved-doctors';
const clinic: string = randomUUID();
const otherClinic: string = randomUUID();
const doctor: string = randomUUID();
const doctor2: string = randomUUID();

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
const hdr = (
  cookie: string | null,
  origin: string | null = 'http://localhost',
) => {
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);
  if (cookie) headers.set('cookie', cookie);
  return headers;
};
const ctx = (c: string, d: string) => ({
  params: Promise.resolve({ clinicId: c, doctorId: d }),
});
const put = (
  cookie: string | null,
  c = clinic,
  d = doctor,
  origin?: string | null,
) =>
  savePut(
    new Request(`${BASE}/${c}/${d}`, {
      method: 'PUT',
      headers: hdr(cookie, origin),
    }),
    ctx(c, d),
  );
const del = (cookie: string | null, c = clinic, d = doctor) =>
  removeDelete(
    new Request(`${BASE}/${c}/${d}`, {
      method: 'DELETE',
      headers: hdr(cookie),
    }),
    ctx(c, d),
  );
const list = async (cookie: string | null) =>
  listGet(new Request(BASE, { headers: hdr(cookie) }));
const count = async () =>
  Number(
    (await pool.query('SELECT count(*) n FROM patient_saved_doctors')).rows[0]
      .n,
  );

async function seedDoctor(clinicId: string, doctorId: string, name: string) {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,$2,$3)`,
    [userId, `doc-${userId}`, name],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,$3)`,
    [doctorId, userId, name],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [clinicId, doctorId],
  );
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = SECRET;
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE patient_saved_doctors, doctor_clinics, doctor_profiles, clinics, patient_credentials, users, staff_sign_in_rate_limit_buckets CASCADE`,
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'sd-a','Clinique Al Amal'),($2,'sd-b','Clinic B')`,
    [clinic, otherClinic],
  );
  await seedDoctor(clinic, doctor, 'Dr Amine');
  await seedDoctor(otherClinic, doctor2, 'Dr Sara');
  for (const [email, name] of [
    [A, 'Leila'],
    [B, 'Karim'],
  ] as const)
    await registerPatientAccount(getPool(), {
      email,
      displayName: name,
      password: PASS,
    });
});
afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('patient saved doctor routes', () => {
  it('requires a patient session', async () => {
    expect((await list(null)).status).toBe(401);
    expect((await put(null)).status).toBe(401);
    expect((await del(null)).status).toBe(401);
    expect(await count()).toBe(0);
  });

  it('saves idempotently and lists the exact public shape', async () => {
    const a = await login(A);
    expect((await put(a)).status).toBe(201);
    expect((await put(a)).status).toBe(200);
    expect(await count()).toBe(1);
    const body = await (await list(a)).json();
    expect(body.doctors).toHaveLength(1);
    expect(Object.keys(body.doctors[0]).sort()).toEqual([
      'clinicId',
      'clinicName',
      'displayName',
      'doctorId',
      'savedAt',
    ]);
    expect(body.doctors[0]).toMatchObject({
      clinicId: clinic,
      clinicName: 'Clinique Al Amal',
      doctorId: doctor,
      displayName: 'Dr Amine',
    });
  });

  it('rejects cross-origin mutations before any write', async () => {
    const a = await login(A);
    expect((await put(a, clinic, doctor, 'https://evil.example')).status).toBe(
      403,
    );
    expect((await put(a, clinic, doctor, null)).status).toBe(403);
    expect(await count()).toBe(0);
  });

  it('isolates owners: one account never sees or removes another bookmark', async () => {
    const a = await login(A);
    const b = await login(B);
    await put(a);
    expect((await (await list(b)).json()).doctors).toEqual([]);
    expect((await del(b)).status).toBe(200);
    expect(await count()).toBe(1);
    expect((await (await list(a)).json()).doctors).toHaveLength(1);
    expect((await del(a)).status).toBe(200);
    expect(await count()).toBe(0);
  });

  it('404s an unknown doctor, a mismatched clinic/doctor pair and malformed ids', async () => {
    const a = await login(A);
    expect((await put(a, clinic, randomUUID())).status).toBe(404);
    expect((await put(a, otherClinic, doctor)).status).toBe(404);
    expect((await put(a, 'not-a-uuid', doctor)).status).toBe(400);
    expect(await count()).toBe(0);
  });

  it('refuses a departed doctor and an inactive clinic, and hides them from the list', async () => {
    const a = await login(A);
    await put(a);
    await put(a, otherClinic, doctor2);
    expect((await (await list(a)).json()).doctors).toHaveLength(2);
    await pool.query(
      'UPDATE doctor_clinics SET departed_at = now() WHERE doctor_id = $1',
      [doctor],
    );
    expect(
      (await (await list(a)).json()).doctors.map(
        (d: { doctorId: string }) => d.doctorId,
      ),
    ).toEqual([doctor2]);
    expect((await put(a)).status).toBe(404);
    await pool.query(
      'UPDATE doctor_clinics SET departed_at = NULL WHERE doctor_id = $1',
      [doctor],
    );
    expect((await (await list(a)).json()).doctors).toHaveLength(2);
    await pool.query(`UPDATE clinics SET status = 'inactive' WHERE id = $1`, [
      otherClinic,
    ]);
    expect(
      (await (await list(a)).json()).doctors.map(
        (d: { doctorId: string }) => d.doctorId,
      ),
    ).toEqual([doctor]);
    expect((await put(a, otherClinic, doctor2)).status).toBe(404);
  });

  it('caps saved doctors per account even under concurrent saves', async () => {
    const a = await login(A);
    const extra: string[] = [];
    for (let i = 0; i < SAVED_DOCTOR_LIMIT + 5; i += 1) {
      const id = randomUUID();
      await seedDoctor(clinic, id, `Dr ${i}`);
      extra.push(id);
    }
    const results = await Promise.all(extra.map((id) => put(a, clinic, id)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(SAVED_DOCTOR_LIMIT);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    expect(await count()).toBe(SAVED_DOCTOR_LIMIT);
    // Re-saving an existing bookmark at the cap stays idempotent.
    const existing = (await (await list(a)).json()).doctors[0]
      .doctorId as string;
    expect((await put(a, clinic, existing)).status).toBe(200);
  });

  it('does not count hidden bookmarks toward the cap (no lock-out)', async () => {
    const a = await login(A);
    const ids: string[] = [];
    for (let i = 0; i < SAVED_DOCTOR_LIMIT; i += 1) {
      const id = randomUUID();
      await seedDoctor(clinic, id, `Dr ${i}`);
      ids.push(id);
      expect((await put(a, clinic, id)).status).toBe(201);
    }
    // Positive control: a full list of available bookmarks still refuses.
    expect((await put(a)).status).toBe(409);
    // Departed doctors vanish from list() and must free their cap slots.
    await pool.query(
      'UPDATE doctor_clinics SET departed_at = now() WHERE doctor_id = ANY($1)',
      [ids.slice(0, 3)],
    );
    expect((await (await list(a)).json()).doctors).toHaveLength(
      SAVED_DOCTOR_LIMIT - 3,
    );
    expect((await put(a)).status).toBe(201);
    expect((await put(a, otherClinic, doctor2)).status).toBe(201);
    expect((await put(a, clinic, ids[10]!)).status).toBe(200);
  });

  it('removes bookmarks when the account or the association is deleted', async () => {
    const a = await login(A);
    await put(a);
    await pool.query('DELETE FROM doctor_clinics WHERE doctor_id = $1', [
      doctor,
    ]);
    expect(await count()).toBe(0);
    await put(a, otherClinic, doctor2);
    await pool.query('DELETE FROM patient_credentials');
    await pool.query(`DELETE FROM users WHERE auth_subject LIKE '%leila%'`);
    expect(await count()).toBe(0);
  });
});
