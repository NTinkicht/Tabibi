import { createHash, randomUUID } from 'node:crypto';
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
  otherClinic: randomUUID(),
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
    ($1,'guest-actor','Reception'),($2,'guest-doctor','Doctor')`,
    [ids.actor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
    ($1,'guest-one','Guest One'),($2,'guest-two','Guest Two')`,
    [ids.clinic, ids.otherClinic],
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
    VALUES($1,$2,$3,'2026-09-09','2026-09-09T09:00Z','2026-09-09T12:00Z','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
    (id,clinic_id,private_display_name,contact_phone) VALUES($1,$2,'Guest','0555000000')`,
    [ids.patient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO queue_entries
    (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
    VALUES($1,$2,$3,$4,'waiting','walk_in',1,'G-001')`,
    [ids.entry, ids.clinic, ids.session, ids.patient],
  );
});
afterAll(async () => pool.end());

describe('guest exchange credentials', () => {
  it('persists only verifiers, then consumes exactly once with target binding and safe audit metadata', async () => {
    const service = new GuestAccessService(pool);
    const issued = await service.issue(
      target,
      ids.actor,
      new Date('2026-09-09T09:00:00Z'),
    );
    const before = await pool.query('SELECT * FROM guest_exchange_ids');
    expect(before.rows[0].exchange_verifier).toBe(
      createHash('sha256').update(issued.exchangeId).digest('hex'),
    );
    expect(JSON.stringify(before.rows)).not.toContain(issued.exchangeId);
    expect((await pool.query('SELECT * FROM guest_credentials')).rowCount).toBe(
      0,
    );

    await expect(
      service.consume(
        issued.exchangeId,
        { ...target, clinicId: ids.otherClinic },
        new Date('2026-09-09T09:01:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
    const consumed = await service.consume(
      issued.exchangeId,
      target,
      new Date('2026-09-09T09:01:00Z'),
    );
    const persisted = await pool.query('SELECT * FROM guest_credentials');
    expect(persisted.rowCount).toBe(1);
    expect(persisted.rows[0].bearer_verifier).toBe(
      createHash('sha256').update(consumed.bearer).digest('hex'),
    );
    expect(JSON.stringify(persisted.rows)).not.toContain(consumed.bearer);
    await expect(
      service.consume(
        issued.exchangeId,
        target,
        new Date('2026-09-09T09:02:00Z'),
      ),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
    expect((await pool.query('SELECT * FROM guest_credentials')).rowCount).toBe(
      1,
    );
    const audit = JSON.stringify(
      (await pool.query('SELECT action,metadata FROM audit_events ORDER BY id'))
        .rows,
    );
    expect(audit).not.toContain(issued.exchangeId);
    expect(audit).not.toContain(consumed.bearer);
  });

  it('rejects expiry and terminal targets without credential side effects', async () => {
    const service = new GuestAccessService(pool);
    const expired = await service.issue(
      target,
      ids.actor,
      new Date('2026-09-09T09:00:00Z'),
    );
    await expect(
      service.consume(
        expired.exchangeId,
        target,
        new Date('2026-09-09T09:10:00.001Z'),
      ),
    ).rejects.toThrow();
    expect((await pool.query('SELECT * FROM guest_credentials')).rowCount).toBe(
      0,
    );
    const terminal = await service.issue(
      target,
      ids.actor,
      new Date('2026-09-09T10:00:00Z'),
    );
    await pool.query(`UPDATE queue_entries SET state='cancelled' WHERE id=$1`, [
      ids.entry,
    ]);
    await expect(
      service.consume(
        terminal.exchangeId,
        target,
        new Date('2026-09-09T10:01:00Z'),
      ),
    ).rejects.toThrow();
    expect((await pool.query('SELECT * FROM guest_credentials')).rowCount).toBe(
      0,
    );
  });

  it('rejects contact-less issuance', async () => {
    await pool.query(
      'UPDATE patient_operational_records SET contact_phone=NULL WHERE id=$1',
      [ids.patient],
    );
    await expect(
      new GuestAccessService(pool).issue(target, ids.actor),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
    expect(
      (await pool.query('SELECT * FROM guest_exchange_ids')).rowCount,
    ).toBe(0);
  });

  it('rolls consumption back completely when credential creation fails', async () => {
    const issued = await new GuestAccessService(pool).issue(
      target,
      ids.actor,
      new Date('2026-09-09T09:00:00Z'),
    );
    const failing = new GuestAccessService(pool, async () => {
      throw new Error('injected failure');
    });
    await expect(
      failing.consume(
        issued.exchangeId,
        target,
        new Date('2026-09-09T09:01:00Z'),
      ),
    ).rejects.toThrow('injected failure');
    expect(
      (await pool.query('SELECT consumed_at FROM guest_exchange_ids')).rows[0]
        .consumed_at,
    ).toBeNull();
    await expect(
      new GuestAccessService(pool).consume(
        issued.exchangeId,
        target,
        new Date('2026-09-09T09:02:00Z'),
      ),
    ).resolves.toBeTruthy();
  });
});
