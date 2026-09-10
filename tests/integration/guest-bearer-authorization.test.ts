import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  actor: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  entry: randomUUID(),
  patient: randomUUID(),
};
const target = {
  clinicId: ids.clinic,
  sessionId: ids.session,
  queueEntryId: ids.entry,
};

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE guest_credentials,guest_exchange_ids,appointment_recovery_receipts,
    appointment_lifecycle_receipts,appointment_booking_receipts,appointments,audit_events,
    queue_command_receipts,queue_reorder_receipts,queue_registration_receipts,queue_entries,
    patient_operational_records,session_command_receipts,consultation_sessions,schedule_templates,
    doctor_clinics,doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
     ($1,'wu16-reception','Reception'),($2,'wu16-doctor','Doctor')`,
    [ids.actor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'wu16','WU16 Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.actor],
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
     VALUES($1,$2,$3,'2026-09-10','2026-09-10T09:00Z','2026-09-10T12:00Z','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
     (id,clinic_id,private_display_name,contact_phone)
     VALUES($1,$2,'Guest','0555000000')`,
    [ids.patient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO queue_entries
     (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','walk_in',1,'G-016')`,
    [ids.entry, ids.clinic, ids.session, ids.patient],
  );
});
afterAll(async () => pool.end());

async function liveBearer() {
  const service = new GuestAccessService(pool);
  const issued = await service.issue(
    target,
    ids.actor,
    new Date('2026-09-10T09:00:00Z'),
  );
  return service.consume(
    issued.exchangeId,
    target,
    new Date('2026-09-10T09:01:00Z'),
  );
}

describe('WU16 guest bearer authorization', () => {
  it('authorizes the exact active target without mutating credential lifecycle or audit state', async () => {
    const service = new GuestAccessService(pool);
    const credential = await liveBearer();
    const before = await pool.query(
      'SELECT issued_at,expires_at,revoked_at FROM guest_credentials',
    );
    const auditsBefore = await pool.query<{ count: string }>(
      'SELECT count(*)::text count FROM audit_events',
    );

    await expect(
      service.authorize(
        credential.bearer,
        target,
        new Date('2026-09-10T09:02:00Z'),
      ),
    ).resolves.toEqual(target);

    expect(
      await pool.query(
        'SELECT issued_at,expires_at,revoked_at FROM guest_credentials',
      ),
    ).toMatchObject({ rows: before.rows });
    expect(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text count FROM audit_events',
        )
      ).rows[0].count,
    ).toBe(auditsBefore.rows[0].count);
  });

  it('rejects an equal-length invalid bearer verifier without exposing the raw secret to SQL', async () => {
    const service = new GuestAccessService(pool);
    const credential = await liveBearer();
    const separator = credential.bearer.indexOf('.');
    const credentialId = credential.bearer.slice(0, separator);
    const bearerSecret = credential.bearer.slice(separator + 1);
    const replacement = bearerSecret.endsWith('A') ? 'B' : 'A';
    const invalidBearer = `${credentialId}.${bearerSecret.slice(0, -1)}${replacement}`;

    expect(invalidBearer).toHaveLength(credential.bearer.length);
    await expect(
      service.authorize(
        invalidBearer,
        target,
        new Date('2026-09-10T09:02:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
  });

  it('rejects an unknown credential id generically', async () => {
    const service = new GuestAccessService(pool);
    const credential = await liveBearer();
    const separator = credential.bearer.indexOf('.');
    const bearerSecret = credential.bearer.slice(separator + 1);
    const unknownBearer = `${randomUUID()}.${bearerSecret}`;

    await expect(
      service.authorize(
        unknownBearer,
        target,
        new Date('2026-09-10T09:02:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
  });

  it('rejects a cross-clinic expected target generically', async () => {
    const service = new GuestAccessService(pool);
    const credential = await liveBearer();

    await expect(
      service.authorize(
        credential.bearer,
        { ...target, clinicId: randomUUID() },
        new Date('2026-09-10T09:02:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
  });

  it('rejects a cancelled consultation session generically', async () => {
    const service = new GuestAccessService(pool);
    const credential = await liveBearer();
    await pool.query(
      "UPDATE consultation_sessions SET status='cancelled' WHERE id=$1",
      [ids.session],
    );

    await expect(
      service.authorize(
        credential.bearer,
        target,
        new Date('2026-09-10T09:02:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
  });

  it('rejects wrong target, revocation, expiry, and terminal queue state generically', async () => {
    const service = new GuestAccessService(pool);
    const credential = await liveBearer();

    await expect(
      service.authorize(
        credential.bearer,
        { ...target, queueEntryId: randomUUID() },
        new Date('2026-09-10T09:02:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);

    await pool.query('UPDATE guest_credentials SET revoked_at=$1', [
      new Date('2026-09-10T09:03:00Z'),
    ]);
    await expect(
      service.authorize(
        credential.bearer,
        target,
        new Date('2026-09-10T09:04:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);

    await pool.query(
      'UPDATE guest_credentials SET revoked_at=NULL,expires_at=$1',
      [new Date('2026-09-10T09:04:30Z')],
    );
    await expect(
      service.authorize(
        credential.bearer,
        target,
        new Date('2026-09-10T09:05:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);

    await pool.query('UPDATE guest_credentials SET expires_at=$1', [
      new Date('2026-09-11T09:00:00Z'),
    ]);
    await pool.query("UPDATE queue_entries SET state='cancelled' WHERE id=$1", [
      ids.entry,
    ]);
    await expect(
      service.authorize(
        credential.bearer,
        target,
        new Date('2026-09-10T09:06:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
  });
});
