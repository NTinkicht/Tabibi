import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { migrate } from '../../scripts/db/lib';

const actorFor = vi.hoisted(() => ({ id: '' }));
vi.mock('@/platform/http/staff-auth', async (original) => ({
  ...(await original<typeof import('@/platform/http/staff-auth')>()),
  authenticatedClinicScope: async (_request: Request, clinicId: string) => ({
    clinicId,
    actorUserId: actorFor.id,
  }),
}));
import { POST } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/status-link/route';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  other: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  entry: randomUUID(),
  patient: randomUUID(),
};

function call(clinicId: string) {
  return POST(
    new Request(
      `https://tabibi.test/api/clinics/${clinicId}/sessions/${ids.session}/queue/${ids.entry}/status-link`,
      { method: 'POST', headers: { origin: 'https://tabibi.test' } },
    ),
    {
      params: Promise.resolve({
        clinicId,
        sessionId: ids.session,
        entryId: ids.entry,
      }),
    },
  );
}

beforeAll(async () => migrate());
beforeEach(async () => {
  actorFor.id = ids.receptionist;
  await pool.query(`TRUNCATE guest_credentials,guest_exchange_ids,appointment_recovery_receipts,
    appointment_lifecycle_receipts,appointment_booking_receipts,appointments,audit_events,
    queue_command_receipts,queue_reorder_receipts,queue_registration_receipts,queue_entries,
    patient_operational_records,session_command_receipts,consultation_sessions,schedule_templates,
    doctor_clinics,doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES ($1,'sl-rec','Reception'),($2,'sl-doc','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES ($1,'sl-one','One'),($2,'sl-two','Two')`,
    [ids.clinic, ids.other],
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
     VALUES($1,$2,$3,'2026-09-09','2026-09-09T09:00Z','2026-09-09T12:00Z','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records(id,clinic_id,private_display_name,contact_phone)
     VALUES($1,$2,'Guest','0555000000')`,
    [ids.patient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO queue_entries(id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','walk_in',1,'G-001')`,
    [ids.entry, ids.clinic, ids.session, ids.patient],
  );
});
afterAll(async () => pool.end());

describe('receptionist status-link route against the database', () => {
  it('mints a link for same-clinic staff, stores only a verifier, and audits without link material', async () => {
    const response = await call(ids.clinic);
    expect(response.status).toBe(201);
    const { statusLink } = await response.json();
    const exchangeId = String(statusLink.url).split('/').pop() as string;
    expect(statusLink.url).toBe(
      `https://tabibi.test/api/guest/exchange/${exchangeId}`,
    );
    expect(statusLink.singleUse).toBe(true);
    const rows = await pool.query('SELECT * FROM guest_exchange_ids');
    expect(rows.rowCount).toBe(1);
    expect(JSON.stringify(rows.rows)).not.toContain(exchangeId);
    const audit = await pool.query(
      `SELECT * FROM audit_events WHERE action='guest_exchange_issued'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(JSON.stringify(audit.rows)).not.toContain(exchangeId);
  });

  it('denies staff of another clinic (tenant isolation) and issues nothing', async () => {
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
      [ids.other, ids.doctorUser],
    );
    actorFor.id = ids.doctorUser;
    // Member of clinic two asking for clinic one's entry via clinic one's URL
    expect((await call(ids.clinic)).status).toBe(403);
    // Same member using their own clinic id with clinic one's entry
    expect((await call(ids.other)).status).toBe(409);
    expect(
      (await pool.query('SELECT 1 FROM guest_exchange_ids')).rowCount,
    ).toBe(0);
  });

  it('denies a doctor-role member', async () => {
    await pool.query(
      `UPDATE clinic_memberships SET role='doctor' WHERE user_id=$1`,
      [ids.receptionist],
    );
    expect((await call(ids.clinic)).status).toBe(403);
    expect(
      (await pool.query('SELECT 1 FROM guest_exchange_ids')).rowCount,
    ).toBe(0);
  });
});
