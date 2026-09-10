import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/guest/status/route';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  patient: randomUUID(),
  entry: randomUUID(),
  credential: randomUUID(),
};
const secret = 'wu17-forwarding-valid-secret';
const bearer = `${ids.credential}.${secret}`;

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE guest_status_rate_limit_buckets,guest_credentials,
    guest_exchange_ids,appointment_recovery_receipts,appointment_lifecycle_receipts,
    appointment_booking_receipts,appointments,audit_events,queue_command_receipts,
    queue_reorder_receipts,queue_registration_receipts,queue_entries,
    patient_operational_records,session_command_receipts,consultation_sessions,
    schedule_templates,doctor_clinics,doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name)
     VALUES($1,'wu17-forwarding-doctor','Doctor')`,
    [ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'wu17-forwarding','WU17 Forwarding')`,
    [ids.clinic],
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
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,current_date,now()-interval '5 minutes',now()+interval '2 hours','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
       (id,clinic_id,private_display_name)
     VALUES($1,$2,'Guest')`,
    [ids.patient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','walk_in',1,'G-FWD')`,
    [ids.entry, ids.clinic, ids.session, ids.patient],
  );
  await pool.query(
    `INSERT INTO guest_credentials
       (id,clinic_id,session_id,queue_entry_id,bearer_verifier,issued_at,expires_at)
     VALUES($1,$2,$3,$4,$5,now(),now()+interval '1 hour')`,
    [
      ids.credential,
      ids.clinic,
      ids.session,
      ids.entry,
      createHash('sha256').update(secret).digest('hex'),
    ],
  );
});
afterAll(async () => pool.end());

describe('WU17 guest status trusted ingress boundary', () => {
  it('does not let spoofed forwarding headers create independent pre-auth buckets', async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await GET(
        new Request('http://localhost/api/guest/status', {
          headers: {
            'cf-connecting-ip': `198.51.100.${attempt + 1}`,
            'x-real-ip': `203.0.113.${attempt + 1}`,
            'x-forwarded-for': `192.0.2.${attempt + 1}, 10.0.0.1`,
          },
        }),
      );
      expect(response.status).toBe(attempt < 6 ? 401 : 429);
    }

    const limited = await GET(
      new Request('http://localhost/api/guest/status', {
        headers: {
          'cf-connecting-ip': '198.51.100.250',
          'x-real-ip': '203.0.113.250',
          'x-forwarded-for': '192.0.2.250',
        },
      }),
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');

    const buckets = await pool.query<{ count: string }>(
      'SELECT count(*)::text count FROM guest_status_rate_limit_buckets',
    );
    expect(buckets.rows[0]?.count).toBe('1');
  });

  it('does not let exhausted invalid traffic throttle an unrelated valid bearer', async () => {
    for (let attempt = 0; attempt < 31; attempt++) {
      await GET(new Request('http://localhost/api/guest/status'));
    }

    const valid = await GET(
      new Request('http://localhost/api/guest/status', {
        headers: { cookie: `__Host-tabibi_guest=${bearer}` },
      }),
    );

    expect(valid.status).toBe(200);
    const payload = await valid.json();
    expect(payload).toMatchObject({
      terminal: false,
      target: {
        clinicId: ids.clinic,
        sessionId: ids.session,
        queueEntryId: ids.entry,
      },
    });
  });
});
