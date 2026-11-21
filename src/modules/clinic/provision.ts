import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

// Operator-only clinic provisioning (TAB-P1-07). There is deliberately no HTTP
// route: creating a tenant is a platform operation, and platform_admin has no
// implicit clinic access. The first clinic_admin is added afterwards with
// bootstrapFirstClinicAdmin.

const TENANT_KEY = /^[a-z0-9][a-z0-9-]{1,62}$/;
const LOCALES = ['ar', 'fr'] as const;
export type ProvisionLocale = (typeof LOCALES)[number];

export class ClinicProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClinicProvisioningError';
  }
}

export interface ProvisionClinicInput {
  tenantKey: string;
  name: string;
  timezone?: string;
  defaultLocale?: ProvisionLocale;
}

export type ProvisionResult =
  | { status: 'created'; clinicId: string }
  | { status: 'already_exists'; clinicId: string };

/**
 * Idempotent on tenant_key: a repeat call returns the existing clinic id and
 * changes nothing, so a retried onboarding can never overwrite a live clinic's
 * name or timezone. The unique tenant_key arbitrates concurrent callers.
 */
export async function provisionClinic(
  pool: Pool,
  input: ProvisionClinicInput,
): Promise<ProvisionResult> {
  const tenantKey = input.tenantKey;
  if (!TENANT_KEY.test(tenantKey))
    throw new ClinicProvisioningError('Invalid tenant key');
  const name = input.name.trim();
  if (name === '' || name.length > 120)
    throw new ClinicProvisioningError('Invalid clinic name');
  const timezone = input.timezone ?? 'Africa/Algiers';
  const defaultLocale = input.defaultLocale ?? 'ar';
  if (!LOCALES.includes(defaultLocale))
    throw new ClinicProvisioningError('Invalid default locale');
  const zone = await pool.query(
    'SELECT 1 FROM pg_timezone_names WHERE name = $1',
    [timezone],
  );
  if (zone.rowCount === 0)
    throw new ClinicProvisioningError(
      'Clinic timezone must be a known IANA timezone name',
    );
  const clinicId = randomUUID();
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO clinics (id, tenant_key, name, timezone, default_locale)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_key) DO NOTHING
     RETURNING id`,
    [clinicId, tenantKey, name, timezone, defaultLocale],
  );
  if (inserted.rowCount === 1) return { status: 'created', clinicId };
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM clinics WHERE tenant_key = $1',
    [tenantKey],
  );
  return { status: 'already_exists', clinicId: existing.rows[0].id };
}
