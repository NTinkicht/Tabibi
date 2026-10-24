import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import {
  ConsultationTypeConflictError,
  ConsultationTypeNotFoundError,
  ConsultationTypeService,
} from '@/modules/scheduling';

// TAB-P0-02 (#651): clinic-scoped consultation types with nominal durations.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const service = new ConsultationTypeService(pool);

const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  outsider: randomUUID(),
};
const admin = { clinicId: ids.clinic, actorUserId: ids.admin };
const otherAdmin = { clinicId: ids.otherClinic, actorUserId: ids.otherAdmin };
const receptionist = { clinicId: ids.clinic, actorUserId: ids.receptionist };
const doctor = { clinicId: ids.clinic, actorUserId: ids.doctorUser };
const outsider = { clinicId: ids.clinic, actorUserId: ids.outsider };
// An admin of another clinic acting against this clinic.
const crossAdmin = { clinicId: ids.clinic, actorUserId: ids.otherAdmin };

const GENERAL = {
  code: 'general',
  label: 'Consultation générale',
  nominalDurationMinutes: 15,
};

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, consultation_types,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'ct-admin', 'Admin'), ($2, 'ct-other-admin', 'Other Admin'),
       ($3, 'ct-receptionist', 'Receptionist'), ($4, 'ct-doctor', 'Doctor'),
       ($5, 'ct-outsider', 'Outsider')`,
    [ids.admin, ids.otherAdmin, ids.receptionist, ids.doctorUser, ids.outsider],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'ct-clinic', 'Clinic'), ($2, 'ct-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'), ($1, $5, 'doctor'),
       ($2, $6, 'clinic_admin')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.doctorUser,
      ids.otherAdmin,
    ],
  );
});

afterAll(async () => pool.end());

async function auditRows(): Promise<
  Array<{ clinic_id: string; action: string; metadata: unknown }>
> {
  const result = await pool.query(
    `SELECT clinic_id, action, metadata FROM audit_events
      WHERE action LIKE 'consultation_type.%' ORDER BY id`,
  );
  return result.rows;
}

describe('consultation type catalogue', () => {
  it('lets a clinic admin create a type, audited without the label', async () => {
    const created = await service.create(admin, {
      ...GENERAL,
      label: '  Consultation générale  ',
    });
    expect(created).toEqual({
      id: expect.any(String),
      clinicId: ids.clinic,
      code: 'general',
      label: 'Consultation générale',
      nominalDurationMinutes: 15,
      active: true,
    });
    expect(await auditRows()).toEqual([
      {
        clinic_id: ids.clinic,
        action: 'consultation_type.created',
        metadata: {
          consultationTypeId: created.id,
          code: 'general',
          nominalDurationMinutes: 15,
        },
      },
    ]);
  });

  it('denies creation to receptionists, doctors, outsiders and other clinics', async () => {
    for (const actor of [receptionist, doctor, outsider, crossAdmin])
      await expect(service.create(actor, GENERAL)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    expect(await service.list(admin, { includeInactive: true })).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it.each([
    ['empty code', { code: '' }],
    ['uppercase code', { code: 'General' }],
    ['code with space', { code: 'gen eral' }],
    ['code starting with dash', { code: '-general' }],
    ['code too long', { code: 'a'.repeat(49) }],
    ['blank label', { label: '   ' }],
    ['label too long', { label: 'x'.repeat(81) }],
    ['label with control character', { label: 'Line\nbreak' }],
    ['duration below minimum', { nominalDurationMinutes: 4 }],
    ['duration above maximum', { nominalDurationMinutes: 241 }],
    ['fractional duration', { nominalDurationMinutes: 15.5 }],
    ['non-finite duration', { nominalDurationMinutes: Number.NaN }],
  ])('rejects %s before writing', async (_name, override) => {
    await expect(
      service.create(admin, { ...GENERAL, ...override }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await service.list(admin, { includeInactive: true })).toEqual([]);
  });

  it('accepts the duration bounds and the longest code and label', async () => {
    await service.create(admin, { ...GENERAL, nominalDurationMinutes: 5 });
    await service.create(admin, {
      code: 'a'.repeat(48),
      label: 'x'.repeat(80),
      nominalDurationMinutes: 240,
    });
    expect(
      (await service.list(admin)).map((t) => t.nominalDurationMinutes),
    ).toEqual([240, 5]);
  });

  it('rejects a duplicate code in the same clinic but allows it in another', async () => {
    await service.create(admin, GENERAL);
    await expect(
      service.create(admin, { ...GENERAL, label: 'Again' }),
    ).rejects.toBeInstanceOf(ConsultationTypeConflictError);
    const other = await service.create(otherAdmin, GENERAL);
    expect(other.clinicId).toBe(ids.otherClinic);
    expect((await auditRows()).map((row) => row.action)).toEqual([
      'consultation_type.created',
      'consultation_type.created',
    ]);
  });

  it('lets exactly one of two concurrent duplicate creates win', async () => {
    const results = await Promise.allSettled([
      service.create(admin, GENERAL),
      service.create(admin, GENERAL),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(
      rejected && rejected.status === 'rejected' && rejected.reason,
    ).toBeInstanceOf(ConsultationTypeConflictError);
    expect(await auditRows()).toHaveLength(1);
  });

  it('lists only the caller clinic types to any member, active by default', async () => {
    const general = await service.create(admin, GENERAL);
    const followUp = await service.create(admin, {
      code: 'follow-up',
      label: 'Suivi',
      nominalDurationMinutes: 10,
    });
    await service.create(otherAdmin, {
      code: 'other-only',
      label: 'Other',
      nominalDurationMinutes: 20,
    });
    await service.setActive(admin, {
      consultationTypeId: followUp.id,
      active: false,
    });
    for (const actor of [admin, receptionist, doctor]) {
      expect((await service.list(actor)).map((t) => t.id)).toEqual([
        general.id,
      ]);
      expect(
        (await service.list(actor, { includeInactive: true })).map(
          (t) => t.code,
        ),
      ).toEqual(['follow-up', 'general']);
    }
    for (const actor of [outsider, crossAdmin])
      await expect(service.list(actor)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
  });

  it('deactivates and reactivates with one audit event per real change', async () => {
    const created = await service.create(admin, GENERAL);
    const off = await service.setActive(admin, {
      consultationTypeId: created.id,
      active: false,
    });
    expect(off.active).toBe(false);
    expect(
      await service.setActive(admin, {
        consultationTypeId: created.id,
        active: false,
      }),
    ).toEqual(off);
    const on = await service.setActive(admin, {
      consultationTypeId: created.id,
      active: true,
    });
    expect(on).toEqual(created);
    expect(await auditRows()).toEqual([
      expect.objectContaining({ action: 'consultation_type.created' }),
      {
        clinic_id: ids.clinic,
        action: 'consultation_type.deactivated',
        metadata: { consultationTypeId: created.id, code: 'general' },
      },
      {
        clinic_id: ids.clinic,
        action: 'consultation_type.activated',
        metadata: { consultationTypeId: created.id, code: 'general' },
      },
    ]);
  });

  it('denies activation changes to non-admins before revealing existence', async () => {
    const created = await service.create(admin, GENERAL);
    for (const actor of [receptionist, doctor, outsider, crossAdmin])
      for (const consultationTypeId of [created.id, randomUUID(), 'not-a-uuid'])
        await expect(
          service.setActive(actor, { consultationTypeId, active: false }),
        ).rejects.toBeInstanceOf(AuthorizationError);
    expect((await service.list(admin))[0]?.active).toBe(true);
  });

  it('reports unknown and other-clinic ids identically and leaves them unchanged', async () => {
    const foreign = await service.create(otherAdmin, GENERAL);
    for (const consultationTypeId of [foreign.id, randomUUID(), 'not-a-uuid'])
      await expect(
        service.setActive(admin, { consultationTypeId, active: false }),
      ).rejects.toBeInstanceOf(ConsultationTypeNotFoundError);
    expect((await service.list(otherAdmin))[0]?.active).toBe(true);
    expect(await auditRows()).toHaveLength(1);
  });

  it('rejects a non-boolean active flag', async () => {
    const created = await service.create(admin, GENERAL);
    await expect(
      service.setActive(admin, {
        consultationTypeId: created.id,
        active: 'false' as unknown as boolean,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('enforces the catalogue constraints in the database itself', async () => {
    const insert = (code: string, label: string, minutes: number) =>
      pool.query(
        `INSERT INTO consultation_types
           (id, clinic_id, code, label, nominal_duration_minutes)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), ids.clinic, code, label, minutes],
      );
    await expect(insert('Bad', 'Label', 15)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert('ok', ' padded', 15)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert('ok', 'Label', 241)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert('ok', 'Label', 4)).rejects.toMatchObject({
      code: '23514',
    });
  });
});
