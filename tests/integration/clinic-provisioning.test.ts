import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { bootstrapFirstClinicAdmin } from '@/modules/identity/bootstrap-admin';
import {
  ClinicProvisioningError,
  provisionClinic,
} from '@/modules/clinic/provision';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const GOOD = 'correct horse battery';

beforeAll(async () => {
  await migrate();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE audit_events, clinic_memberships, staff_credentials, users, clinics CASCADE',
  );
});

const count = async () =>
  Number((await pool.query('SELECT count(*) FROM clinics')).rows[0].count);

describe('provisionClinic (TAB-P1-07)', () => {
  it('creates an active clinic with defaults', async () => {
    const result = await provisionClinic(pool, {
      tenantKey: 'clinique-alger',
      name: '  Clinique Alger  ',
    });
    expect(result.status).toBe('created');
    const row = (
      await pool.query(
        'SELECT name, timezone, default_locale, status FROM clinics WHERE id = $1',
        [result.clinicId],
      )
    ).rows[0];
    expect(row).toEqual({
      name: 'Clinique Alger',
      timezone: 'Africa/Algiers',
      default_locale: 'ar',
      status: 'active',
    });
  });

  it('is idempotent on tenant key and never overwrites a live clinic', async () => {
    const first = await provisionClinic(pool, {
      tenantKey: 'clinic-a',
      name: 'Original',
    });
    const again = await provisionClinic(pool, {
      tenantKey: 'clinic-a',
      name: 'Hijacked',
      timezone: 'Europe/Paris',
      defaultLocale: 'fr',
    });
    expect(again).toEqual({
      status: 'already_exists',
      clinicId: first.clinicId,
    });
    const row = (
      await pool.query('SELECT name, timezone FROM clinics WHERE id = $1', [
        first.clinicId,
      ])
    ).rows[0];
    expect(row).toEqual({ name: 'Original', timezone: 'Africa/Algiers' });
  });

  it('concurrent calls create exactly one clinic', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        provisionClinic(pool, { tenantKey: 'racing', name: 'Race' }),
      ),
    );
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(new Set(results.map((r) => r.clinicId)).size).toBe(1);
    expect(await count()).toBe(1);
  });

  it.each([
    ['tenant key', { tenantKey: 'Bad Key!', name: 'X' }, /tenant key/],
    ['short tenant key', { tenantKey: 'a', name: 'X' }, /tenant key/],
    ['empty name', { tenantKey: 'ok-key', name: '   ' }, /name/],
    ['long name', { tenantKey: 'ok-key', name: 'x'.repeat(121) }, /name/],
    [
      'unknown timezone',
      { tenantKey: 'ok-key', name: 'X', timezone: 'Mars/Base' },
      /timezone/,
    ],
    [
      'offset timezone',
      { tenantKey: 'ok-key', name: 'X', timezone: '+01:00' },
      /timezone/,
    ],
    [
      'locale',
      { tenantKey: 'ok-key', name: 'X', defaultLocale: 'en' as 'ar' },
      /locale/,
    ],
  ])('refuses invalid %s and creates nothing', async (_l, input, message) => {
    await expect(provisionClinic(pool, input)).rejects.toThrow(
      ClinicProvisioningError,
    );
    await expect(provisionClinic(pool, input)).rejects.toThrow(message);
    expect(await count()).toBe(0);
    // Positive control: the same call with valid values succeeds.
    const ok = await provisionClinic(pool, {
      tenantKey: 'ok-key',
      name: 'X',
    });
    expect(ok.status).toBe('created');
  });

  it('feeds first-admin bootstrap and keeps tenants isolated', async () => {
    const a = await provisionClinic(pool, { tenantKey: 'tenant-a', name: 'A' });
    const b = await provisionClinic(pool, { tenantKey: 'tenant-b', name: 'B' });
    const boot = await bootstrapFirstClinicAdmin(pool, {
      clinicId: a.clinicId,
      email: 'admin@a.example',
      displayName: 'Admin A',
      password: GOOD,
    });
    expect(boot.status).toBe('created');
    const memberships = await pool.query(
      'SELECT clinic_id, role FROM clinic_memberships',
    );
    expect(memberships.rows).toEqual([
      { clinic_id: a.clinicId, role: 'clinic_admin' },
    ]);
    expect(memberships.rows.some((m) => m.clinic_id === b.clinicId)).toBe(
      false,
    );
  });
});
