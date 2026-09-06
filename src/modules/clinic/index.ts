import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import {
  type ClinicRole,
  type ClinicScope,
  requireClinicRole,
} from '@/modules/identity';
import { inTransaction } from '@/platform/database/transaction';

export interface Clinic {
  id: string;
  tenantKey: string;
  name: string;
  timezone: string;
  defaultLocale: 'ar' | 'fr';
  enabledLocales: Array<'ar' | 'fr'>;
  status: 'active' | 'inactive';
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

interface ClinicRow {
  id: string;
  tenant_key: string;
  name: string;
  timezone: string;
  default_locale: 'ar' | 'fr';
  enabled_locales: Array<'ar' | 'fr'>;
  status: 'active' | 'inactive';
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
  };
}

export class ClinicService {
  constructor(private readonly pool: Pool) {}

  async getClinic(scope: ClinicScope): Promise<Clinic> {
    await requireClinicRole(this.pool, scope, [
      'doctor',
      'receptionist',
      'clinic_admin',
    ]);
    const result = await this.pool.query<ClinicRow>(
      `SELECT id, tenant_key, name, timezone, default_locale, enabled_locales, status
         FROM clinics WHERE id = $1`,
      [scope.clinicId],
    );
    if (!result.rows[0]) throw new Error('Clinic not found');
    return clinicFromRow(result.rows[0]);
  }

  async updateClinic(
    scope: ClinicScope,
    update: {
      name: string;
      timezone?: string;
      defaultLocale?: 'ar' | 'fr';
      enabledLocales?: Array<'ar' | 'fr'>;
      status?: 'active' | 'inactive';
    },
  ): Promise<Clinic> {
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['clinic_admin']);
      const result = await client.query<ClinicRow>(
        `UPDATE clinics SET name = $2, timezone = COALESCE($3, timezone),
           default_locale = COALESCE($4, default_locale),
           enabled_locales = COALESCE($5, enabled_locales),
           status = COALESCE($6, status), updated_at = now()
         WHERE id = $1
         RETURNING id, tenant_key, name, timezone, default_locale, enabled_locales, status`,
        [
          scope.clinicId,
          update.name,
          update.timezone ?? null,
          update.defaultLocale ?? null,
          update.enabledLocales ?? null,
          update.status ?? null,
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

  async setMembership(
    scope: ClinicScope,
    userId: string,
    role: ClinicRole,
  ): Promise<void> {
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['clinic_admin']);
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

  async addDoctor(
    scope: ClinicScope,
    doctor: { userId: string; displayName: string; doctorId?: string },
  ): Promise<string> {
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['clinic_admin']);
      const doctorId = doctor.doctorId ?? randomUUID();
      await client.query(
        `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
        [doctorId, doctor.userId, doctor.displayName],
      );
      const profile = await client.query<{ id: string }>(
        'SELECT id FROM doctor_profiles WHERE user_id = $1',
        [doctor.userId],
      );
      const id = profile.rows[0]!.id;
      await client.query(
        `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [scope.clinicId, id],
      );
      await client.query(
        `INSERT INTO clinic_memberships (clinic_id, user_id, role)
         VALUES ($1, $2, 'doctor')
         ON CONFLICT (clinic_id, user_id) DO UPDATE SET role = 'doctor', updated_at = now()`,
        [scope.clinicId, doctor.userId],
      );
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'doctor',
        entityId: id,
        action: 'doctor.associated',
      });
      return id;
    });
  }
}
