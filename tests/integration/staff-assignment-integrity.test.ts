import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import {
  ClinicService,
  DoctorMembershipRequiresAssociationError,
  LastClinicAdminError,
  MembershipUserNotFoundError,
} from '@/modules/clinic';
import { AuthorizationError } from '@/modules/identity';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  adminA: randomUUID(),
  adminA2: randomUUID(),
  receptionistA: randomUUID(),
  adminB: randomUUID(),
  outsider: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
};

const scopeA = { clinicId: ids.clinicA, actorUserId: ids.adminA };

async function membershipRows(clinicId: string) {
  const result = await pool.query<{ user_id: string; role: string }>(
    `SELECT user_id, role::text AS role FROM clinic_memberships
      WHERE clinic_id = $1 ORDER BY user_id`,
    [clinicId],
  );
  return result.rows;
}

async function membershipAuditCount(clinicId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE clinic_id = $1 AND action = 'membership.set'`,
    [clinicId],
  );
  return Number(result.rows[0]!.count);
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'sa-admin-a', 'Admin A'),
       ($2, 'sa-admin-a2', 'Admin A2'),
       ($3, 'sa-reception-a', 'Reception A'),
       ($4, 'sa-admin-b', 'Admin B'),
       ($5, 'sa-outsider', 'Outsider'),
       ($6, 'sa-doctor', 'Doctor')`,
    [
      ids.adminA,
      ids.adminA2,
      ids.receptionistA,
      ids.adminB,
      ids.outsider,
      ids.doctorUser,
    ],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'sa-clinic-a', 'Clinic A'), ($2, 'sa-clinic-b', 'Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'),
       ($2, $5, 'clinic_admin')`,
    [ids.clinicA, ids.clinicB, ids.adminA, ids.receptionistA, ids.adminB],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  // The doctor is associated with clinic B only.
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [ids.clinicB, ids.doctor],
  );
});

afterAll(async () => pool.end());

describe('staff assignment integrity', () => {
  it("rejects demoting a clinic's last admin, including self-demotion, without side effects", async () => {
    const clinics = new ClinicService(pool);
    const before = await membershipRows(ids.clinicA);

    for (const role of ['receptionist', 'doctor'] as const) {
      await expect(
        clinics.setMembership(scopeA, ids.adminA, role),
      ).rejects.toBeInstanceOf(LastClinicAdminError);
    }

    expect(await membershipRows(ids.clinicA)).toEqual(before);
    expect(await membershipAuditCount(ids.clinicA)).toBe(0);
  });

  it('allows demoting an admin while another admin remains', async () => {
    const clinics = new ClinicService(pool);
    await clinics.setMembership(scopeA, ids.adminA2, 'clinic_admin');
    await clinics.setMembership(scopeA, ids.adminA, 'receptionist');

    expect(await membershipRows(ids.clinicA)).toEqual(
      [
        { user_id: ids.adminA, role: 'receptionist' },
        { user_id: ids.adminA2, role: 'clinic_admin' },
        { user_id: ids.receptionistA, role: 'receptionist' },
      ].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
    );
    expect(await membershipAuditCount(ids.clinicA)).toBe(2);
    // The demoted user has lost admin authority immediately.
    await expect(
      clinics.setMembership(
        { clinicId: ids.clinicA, actorUserId: ids.adminA },
        ids.receptionistA,
        'clinic_admin',
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('serializes concurrent mutual demotion so exactly one admin remains', async () => {
    const clinics = new ClinicService(pool);
    await clinics.setMembership(scopeA, ids.adminA2, 'clinic_admin');

    for (let round = 0; round < 5; round += 1) {
      await pool.query(
        `UPDATE clinic_memberships SET role = 'clinic_admin'
          WHERE clinic_id = $1 AND user_id = ANY($2::uuid[])`,
        [ids.clinicA, [ids.adminA, ids.adminA2]],
      );
      const results = await Promise.allSettled([
        clinics.setMembership(
          { clinicId: ids.clinicA, actorUserId: ids.adminA },
          ids.adminA2,
          'receptionist',
        ),
        clinics.setMembership(
          { clinicId: ids.clinicA, actorUserId: ids.adminA2 },
          ids.adminA,
          'receptionist',
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason;
      expect(
        reason instanceof AuthorizationError ||
          reason instanceof LastClinicAdminError,
      ).toBe(true);
      const admins = (await membershipRows(ids.clinicA)).filter(
        (row) => row.role === 'clinic_admin',
      );
      expect(admins).toHaveLength(1);
    }
  });

  it('accepts the doctor role only for a doctor associated with the clinic', async () => {
    const clinics = new ClinicService(pool);
    await expect(
      clinics.setMembership(scopeA, ids.outsider, 'doctor'),
    ).rejects.toBeInstanceOf(DoctorMembershipRequiresAssociationError);
    // A doctor profile associated with another clinic is not enough.
    await expect(
      clinics.setMembership(scopeA, ids.doctorUser, 'doctor'),
    ).rejects.toBeInstanceOf(DoctorMembershipRequiresAssociationError);
    expect(await membershipRows(ids.clinicA)).toHaveLength(2);
    expect(await membershipAuditCount(ids.clinicA)).toBe(0);

    await pool.query(
      `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
      [ids.clinicA, ids.doctor],
    );
    await clinics.setMembership(scopeA, ids.doctorUser, 'doctor');
    expect(await membershipRows(ids.clinicA)).toContainEqual({
      user_id: ids.doctorUser,
      role: 'doctor',
    });
    expect(await membershipAuditCount(ids.clinicA)).toBe(1);
  });

  it('rejects an unknown user with a typed error and writes nothing', async () => {
    const clinics = new ClinicService(pool);
    await expect(
      clinics.setMembership(scopeA, randomUUID(), 'receptionist'),
    ).rejects.toBeInstanceOf(MembershipUserNotFoundError);
    expect(await membershipRows(ids.clinicA)).toHaveLength(2);
    expect(await membershipAuditCount(ids.clinicA)).toBe(0);
  });

  it('treats setting the current role as a no-op without an audit event', async () => {
    const clinics = new ClinicService(pool);
    await clinics.setMembership(scopeA, ids.receptionistA, 'receptionist');
    await clinics.setMembership(scopeA, ids.adminA, 'clinic_admin');
    expect(await membershipAuditCount(ids.clinicA)).toBe(0);

    await clinics.setMembership(scopeA, ids.outsider, 'receptionist');
    await clinics.setMembership(scopeA, ids.outsider, 'receptionist');
    expect(await membershipAuditCount(ids.clinicA)).toBe(1);
  });

  it('keeps every rule inside the actor clinic', async () => {
    const clinics = new ClinicService(pool);
    // Clinic A's admin cannot touch clinic B's last admin.
    await expect(
      clinics.setMembership(
        { clinicId: ids.clinicB, actorUserId: ids.adminA },
        ids.adminB,
        'receptionist',
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // Clinic B's own admin is still protected as its last admin.
    await expect(
      clinics.setMembership(
        { clinicId: ids.clinicB, actorUserId: ids.adminB },
        ids.adminB,
        'receptionist',
      ),
    ).rejects.toBeInstanceOf(LastClinicAdminError);
    expect(await membershipRows(ids.clinicB)).toEqual([
      { user_id: ids.adminB, role: 'clinic_admin' },
    ]);
  });
});
