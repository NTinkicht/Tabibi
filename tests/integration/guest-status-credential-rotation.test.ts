import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GuestAccessRejectedError,
  GuestAccessService,
  type GuestTarget,
} from '@/modules/guest-access';
import { GuestStatusService } from '@/modules/guest-status';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  actor: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  patient: randomUUID(),
  queueEntry: randomUUID(),
};
const target: GuestTarget = {
  clinicId: ids.clinic,
  sessionId: ids.session,
  queueEntryId: ids.queueEntry,
};

class RotatingGuestAccessService extends GuestAccessService {
  private raced = false;

  constructor(private readonly testPool: Pool) {
    super(testPool);
  }

  override async authorize(
    bearer: string,
    expectedTarget?: GuestTarget,
    now = new Date(),
  ): Promise<GuestTarget> {
    const authorized = await super.authorize(bearer, expectedTarget, now);
    if (!this.raced) {
      this.raced = true;
      const separator = bearer.indexOf('.');
      const credentialId = bearer.slice(0, separator);
      await this.testPool.query(
        'UPDATE guest_credentials SET revoked_at=$2 WHERE id=$1',
        [credentialId, now],
      );
      await this.testPool.query(
        `INSERT INTO guest_credentials
           (id,clinic_id,session_id,queue_entry_id,bearer_verifier,issued_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          authorized.clinicId,
          authorized.sessionId,
          authorized.queueEntryId,
          '0'.repeat(64),
          now,
          new Date(now.getTime() + 60 * 60 * 1_000),
        ],
      );
    }
    return authorized;
  }
}

beforeAll(async () => {
  await migrate();
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
     ($1,$3,'WU17 Race Reception'),($2,$4,'WU17 Race Doctor')`,
    [
      ids.actor,
      ids.doctorUser,
      `wu17-race-${ids.actor}`,
      `wu17-race-${ids.doctorUser}`,
    ],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,$2,'WU17 Race Clinic')`,
    [ids.clinic, `wu17-race-${ids.clinic}`],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.actor],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'WU17 Race Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    'INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)',
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
     VALUES($1,$2,'WU17 Race Guest','0555999999')`,
    [ids.patient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,eligibility_order,public_display_label)
     VALUES($1,$2,$3,$4,'checked_in','walk_in',1,1,'G-RACE')`,
    [ids.queueEntry, ids.clinic, ids.session, ids.patient],
  );
});

afterAll(async () => {
  await pool.end();
});

describe('WU17 credential rotation race', () => {
  it('rejects an old bearer when its exact credential is revoked after authorization', async () => {
    const access = new GuestAccessService(pool);
    const issued = await access.issue(
      target,
      ids.actor,
      new Date('2026-09-10T09:00:00Z'),
    );
    const credential = await access.consume(
      issued.exchangeId,
      target,
      new Date('2026-09-10T09:01:00Z'),
    );
    const service = new GuestStatusService(
      pool,
      new RotatingGuestAccessService(pool),
    );

    await expect(
      service.getSnapshot(credential.bearer, new Date('2026-09-10T09:02:00Z')),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);

    const active = await pool.query<{ count: string }>(
      `SELECT count(*)::text count
         FROM guest_credentials
        WHERE queue_entry_id=$1 AND revoked_at IS NULL`,
      [ids.queueEntry],
    );
    expect(active.rows[0]?.count).toBe('1');
  });
});
