import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import {
  type ClinicRole,
  type ClinicScope,
  requireClinicRole,
} from '@/modules/identity';
import { abortableQuery } from '@/platform/database/abortable-query';
import { inTransaction } from '@/platform/database/transaction';

export {
  WILAYA_LIST_VERSION,
  WILAYAS,
  type Wilaya,
  isWilayaCode,
} from './wilayas';

export interface Clinic {
  id: string;
  tenantKey: string;
  name: string;
  timezone: string;
  defaultLocale: 'ar' | 'fr';
  enabledLocales: Array<'ar' | 'fr'>;
  status: 'active' | 'inactive';
  // TAB-P0-02 (#686): the clinic's single location; all null when unset.
  wilayaCode: string | null;
  commune: string | null;
  addressLine: string | null;
}

export interface ClinicLocation {
  wilayaCode: string | null;
  commune: string | null;
  addressLine: string | null;
}

export interface ClinicMembership {
  userId: string;
  role: ClinicRole;
}

export interface ClinicDoctor {
  id: string;
  userId: string;
  displayName: string;
}

export interface PublicDiscoveryDoctor {
  displayName: string;
}

export interface PublicDiscoveryClinic {
  name: string;
  defaultLocale: 'ar' | 'fr';
  enabledLocales: Array<'ar' | 'fr'>;
  doctors: PublicDiscoveryDoctor[];
}

interface ClinicRow {
  id: string;
  tenant_key: string;
  name: string;
  timezone: string;
  default_locale: 'ar' | 'fr';
  enabled_locales: Array<'ar' | 'fr'>;
  status: 'active' | 'inactive';
  wilaya_code: string | null;
  commune: string | null;
  address_line: string | null;
}

const CLINIC_COLUMNS = `id, tenant_key, name, timezone, default_locale, enabled_locales, status,
  wilaya_code, commune, address_line`;

interface PublicDiscoveryRow {
  clinic_id: string;
  clinic_name: string;
  default_locale: 'ar' | 'fr';
  enabled_locales: Array<'ar' | 'fr'>;
  doctor_display_name: string | null;
}

function clinicFromRow(row: ClinicRow): Clinic {
  return {
    id: row.id,
    tenantKey: row.tenant_key,
    name: row.name,
    timezone: row.timezone,
    defaultLocale: row.default_locale,
    enabledLocales: row.enabled_locales,
    status: row.status,
    wilayaCode: row.wilaya_code,
    commune: row.commune,
    addressLine: row.address_line,
  };
}

export class PublicDiscoveryService {
  constructor(private readonly pool: Pool) {}

  async listClinics(
    queryTimeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<PublicDiscoveryClinic[]> {
    const text = `SELECT clinic.id AS clinic_id,
              clinic.name AS clinic_name,
              clinic.default_locale,
              clinic.enabled_locales,
              doctor.display_name AS doctor_display_name
         FROM clinics clinic
         LEFT JOIN doctor_clinics association ON association.clinic_id = clinic.id
         LEFT JOIN doctor_profiles doctor ON doctor.id = association.doctor_id
        WHERE clinic.status = 'active'
        ORDER BY clinic.name, clinic.id, doctor.display_name, doctor.id`;
    const result = signal
      ? await abortableQuery<PublicDiscoveryRow>(this.pool, text, [], signal)
      : await this.pool.query<PublicDiscoveryRow>({
          text,
          ...(queryTimeoutMs === undefined
            ? {}
            : { query_timeout: queryTimeoutMs }),
        });

    const clinics: PublicDiscoveryClinic[] = [];
    let current: PublicDiscoveryClinic | undefined;
    let currentKey: string | undefined;

    for (const row of result.rows) {
      const key = row.clinic_id;
      if (key !== currentKey) {
        current = {
          name: row.clinic_name,
          defaultLocale: row.default_locale,
          enabledLocales: row.enabled_locales,
          doctors: [],
        };
        clinics.push(current);
        currentKey = key;
      }
      if (row.doctor_display_name !== null) {
        current!.doctors.push({ displayName: row.doctor_display_name });
      }
    }

    return clinics;
  }
}

// A clinic timezone must be a named IANA zone known to PostgreSQL: every
// clinic-local computation (session generation, service dates) runs
// `AT TIME ZONE clinics.timezone`, so an unknown value would break the clinic
// for all later scheduling. Offset strings and abbreviations are not names in
// pg_timezone_names and are rejected too.
export class InvalidClinicTimezoneError extends Error {
  constructor() {
    super('Clinic timezone must be a known IANA timezone name');
    this.name = 'InvalidClinicTimezoneError';
  }
}

// A clinic must always keep at least one clinic_admin: there is no platform
// bypass in requireClinicRole, so a clinic without an admin could never again
// change memberships, schedules or settings.
export class LastClinicAdminError extends Error {
  constructor() {
    super('A clinic must keep at least one clinic admin');
    this.name = 'LastClinicAdminError';
  }
}

// The doctor role is only meaningful together with a doctor profile associated
// with the clinic (requireDoctorIdentity checks all three); addDoctor creates
// them together.
export class DoctorMembershipRequiresAssociationError extends Error {
  constructor() {
    super('The doctor role requires a doctor associated with this clinic');
    this.name = 'DoctorMembershipRequiresAssociationError';
  }
}

export class MembershipUserNotFoundError extends Error {
  constructor() {
    super('User not found');
    this.name = 'MembershipUserNotFoundError';
  }
}

// setMembership with existingMemberOnly: the user is not a member of this
// clinic (unknown, malformed or only a member elsewhere). Same error for all
// of them, so the staff route is not a cross-clinic membership oracle.
export class MembershipNotFoundError extends Error {
  constructor() {
    super('Membership not found');
    this.name = 'MembershipNotFoundError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClinicService {
  constructor(private readonly pool: Pool) {}

  async getClinic(scope: ClinicScope): Promise<Clinic> {
    await requireClinicRole(this.pool, scope, [
      'doctor',
      'receptionist',
      'clinic_admin',
    ]);
    const result = await this.pool.query<ClinicRow>(
      `SELECT ${CLINIC_COLUMNS} FROM clinics WHERE id = $1`,
      [scope.clinicId],
    );
    if (!result.rows[0]) throw new Error('Clinic not found');
    return clinicFromRow(result.rows[0]);
  }

  async updateClinic(
    scope: ClinicScope,
    update: {
      name?: string;
      timezone?: string;
      defaultLocale?: 'ar' | 'fr';
      enabledLocales?: Array<'ar' | 'fr'>;
      status?: 'active' | 'inactive';
    } & Partial<ClinicLocation>,
  ): Promise<Clinic> {
    // The location is replaced as a whole when any part of it is given
    // (clinic-input.ts requires all three keys together); absent keys keep it.
    const setLocation =
      update.wilayaCode !== undefined ||
      update.commune !== undefined ||
      update.addressLine !== undefined;
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['clinic_admin']);
      if (update.timezone != null) {
        const known = await client.query(
          'SELECT 1 FROM pg_timezone_names WHERE name = $1',
          [update.timezone],
        );
        if (!known.rowCount) throw new InvalidClinicTimezoneError();
      }
      const result = await client.query<ClinicRow>(
        `UPDATE clinics SET name = COALESCE($2, name), timezone = COALESCE($3, timezone),
           default_locale = COALESCE($4, default_locale),
           enabled_locales = COALESCE($5, enabled_locales),
           status = COALESCE($6, status),
           wilaya_code = CASE WHEN $7::boolean THEN $8 ELSE wilaya_code END,
           commune = CASE WHEN $7::boolean THEN $9 ELSE commune END,
           address_line = CASE WHEN $7::boolean THEN $10 ELSE address_line END,
           updated_at = now()
         WHERE id = $1
         RETURNING ${CLINIC_COLUMNS}`,
        [
          scope.clinicId,
          update.name ?? null,
          update.timezone ?? null,
          update.defaultLocale ?? null,
          update.enabledLocales ?? null,
          update.status ?? null,
          setLocation,
          update.wilayaCode ?? null,
          update.commune ?? null,
          update.addressLine ?? null,
        ],
      );
      if (!result.rows[0]) throw new Error('Clinic not found');
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'clinic',
        entityId: scope.clinicId,
        action: 'clinic.updated',
      });
      return clinicFromRow(result.rows[0]);
    });
  }

  async listMemberships(scope: ClinicScope): Promise<ClinicMembership[]> {
    await requireClinicRole(this.pool, scope, ['clinic_admin']);
    const result = await this.pool.query<{
      user_id: string;
      role: ClinicRole;
    }>(
      `SELECT user_id, role FROM clinic_memberships
        WHERE clinic_id = $1 ORDER BY user_id`,
      [scope.clinicId],
    );
    return result.rows.map((row) => ({ userId: row.user_id, role: row.role }));
  }

  async listDoctors(scope: ClinicScope): Promise<ClinicDoctor[]> {
    await requireClinicRole(this.pool, scope, [
      'doctor',
      'receptionist',
      'clinic_admin',
    ]);
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      display_name: string;
    }>(
      `SELECT doctor.id, doctor.user_id, doctor.display_name
         FROM doctor_profiles doctor
         JOIN doctor_clinics association ON association.doctor_id = doctor.id
        WHERE association.clinic_id = $1 ORDER BY doctor.display_name, doctor.id`,
      [scope.clinicId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
    }));
  }

  // Staff-assignment integrity. The clinic row is locked so that concurrent
  // role changes in one clinic serialize: two admins demoting each other at
  // the same time cannot both succeed and leave the clinic without an admin.
  // The actor's own admin role is re-checked under that lock, because a
  // concurrent change may have just demoted them.
  async setMembership(
    scope: ClinicScope,
    userId: string,
    role: ClinicRole,
    options: { existingMemberOnly?: boolean } = {},
  ): Promise<void> {
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['clinic_admin']);
      if (options.existingMemberOnly && !UUID_PATTERN.test(userId)) {
        throw new MembershipNotFoundError();
      }
      await client.query('SELECT 1 FROM clinics WHERE id = $1 FOR UPDATE', [
        scope.clinicId,
      ]);
      await requireClinicRole(client, scope, ['clinic_admin']);
      const user = await client.query('SELECT 1 FROM users WHERE id = $1', [
        userId,
      ]);
      if (user.rowCount !== 1) {
        throw options.existingMemberOnly
          ? new MembershipNotFoundError()
          : new MembershipUserNotFoundError();
      }
      const current = await client.query<{ role: ClinicRole }>(
        `SELECT role FROM clinic_memberships
          WHERE clinic_id = $1 AND user_id = $2`,
        [scope.clinicId, userId],
      );
      const currentRole = current.rows[0]?.role;
      // Checked under the clinic lock (#663): a role change over HTTP never
      // adds a new member; inviting staff is a separate workflow.
      if (options.existingMemberOnly && !currentRole) {
        throw new MembershipNotFoundError();
      }
      if (currentRole === role) return;
      if (currentRole === 'clinic_admin') {
        const otherAdmins = await client.query(
          `SELECT 1 FROM clinic_memberships
            WHERE clinic_id = $1 AND role = 'clinic_admin' AND user_id <> $2`,
          [scope.clinicId, userId],
        );
        if (otherAdmins.rowCount === 0) throw new LastClinicAdminError();
      }
      if (role === 'doctor') {
        const association = await client.query(
          `SELECT 1 FROM doctor_profiles doctor
             JOIN doctor_clinics association ON association.doctor_id = doctor.id
            WHERE doctor.user_id = $1 AND association.clinic_id = $2`,
          [userId, scope.clinicId],
        );
        if (association.rowCount !== 1) {
          throw new DoctorMembershipRequiresAssociationError();
        }
      }
      await client.query(
        `INSERT INTO clinic_memberships (clinic_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (clinic_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, updated_at = now()`,
        [scope.clinicId, userId, role],
      );
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'membership',
        entityId: userId,
        action: 'membership.set',
        metadata: { role },
      });
    });
  }

  // Associate an existing member of this clinic as one of its doctors
  // (TAB-P0-02, #667). Never adds a member (inviting staff is TAB-P1-07):
  // unknown, malformed and other-clinic users are the same
  // MembershipNotFoundError. Serialized with setMembership on the clinic row,
  // the actor's admin role is re-checked under that lock and the last
  // clinic_admin cannot be turned into a doctor. A doctor profile is shared by
  // every clinic the doctor works in, so an existing profile's display name is
  // never overwritten here; displayName only names a new profile. Already
  // associated and already a doctor is a no-op without an audit event.
  async addDoctor(
    scope: ClinicScope,
    doctor: { userId: string; displayName: string },
  ): Promise<{ doctor: ClinicDoctor; changed: boolean }> {
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['clinic_admin']);
      if (!UUID_PATTERN.test(doctor.userId)) {
        throw new MembershipNotFoundError();
      }
      await client.query('SELECT 1 FROM clinics WHERE id = $1 FOR UPDATE', [
        scope.clinicId,
      ]);
      await requireClinicRole(client, scope, ['clinic_admin']);
      const current = await client.query<{ role: ClinicRole }>(
        `SELECT role FROM clinic_memberships
          WHERE clinic_id = $1 AND user_id = $2`,
        [scope.clinicId, doctor.userId],
      );
      const currentRole = current.rows[0]?.role;
      if (!currentRole) throw new MembershipNotFoundError();
      if (currentRole === 'clinic_admin') {
        const otherAdmins = await client.query(
          `SELECT 1 FROM clinic_memberships
            WHERE clinic_id = $1 AND role = 'clinic_admin' AND user_id <> $2`,
          [scope.clinicId, doctor.userId],
        );
        if (otherAdmins.rowCount === 0) throw new LastClinicAdminError();
      }
      await client.query(
        `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING`,
        [randomUUID(), doctor.userId, doctor.displayName],
      );
      const profile = await client.query<{ id: string; display_name: string }>(
        'SELECT id, display_name FROM doctor_profiles WHERE user_id = $1',
        [doctor.userId],
      );
      const { id, display_name: displayName } = profile.rows[0]!;
      const association = await client.query(
        `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [scope.clinicId, id],
      );
      const result = {
        doctor: { id, userId: doctor.userId, displayName },
        changed: association.rowCount === 1 || currentRole !== 'doctor',
      };
      if (!result.changed) return result;
      await client.query(
        `UPDATE clinic_memberships SET role = 'doctor', updated_at = now()
          WHERE clinic_id = $1 AND user_id = $2`,
        [scope.clinicId, doctor.userId],
      );
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'doctor',
        entityId: id,
        action: 'doctor.associated',
      });
      return result;
    });
  }
}
