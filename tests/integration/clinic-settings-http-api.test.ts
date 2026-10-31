import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import * as clinicRoute from '@/app/api/clinics/[clinicId]/route';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

// TAB-P0-02 (#665): clinic settings (name, timezone, locales) over the staff
// HTTP boundary. Authorization stays in ClinicService; the route adds
// origin/session checks, input validation (400, never 500), error mapping and
// an explicit response projection without the tenant key.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
};
const ORIGIN = 'http://localhost';
const CLINIC_KEYS = [
  'addressLine',
  'commune',
  'defaultLocale',
  'enabledLocales',
  'id',
  'name',
  'status',
  'timezone',
  'wilayaCode',
];

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'clinic-settings-http-api-test-secret-at-least-32-chars';
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, staff_sessions,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'cs-admin', 'Admin'), ($2, 'cs-other-admin', 'Other Admin'),
       ($3, 'cs-receptionist', 'Receptionist'), ($4, 'cs-doctor', 'Doctor')`,
    [ids.admin, ids.otherAdmin, ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'cs-clinic', 'Clinic'), ($2, 'cs-other-clinic', 'Other')`,
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

afterAll(async () => {
  await pool.end();
  await closePool();
});

async function call(
  method: 'GET' | 'PATCH',
  subject: string,
  options: { body?: unknown; raw?: string; clinicId?: string } = {},
): Promise<{ status: number; json: Record<string, unknown>; res: Response }> {
  const clinicId = options.clinicId ?? ids.clinic;
  const cookie = `tabibi_staff_session=${await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  )}`;
  const body =
    options.raw ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  const res = await clinicRoute[method](
    new Request(`${ORIGIN}/api/clinics/${clinicId}`, {
      method,
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    }),
    { params: Promise.resolve({ clinicId }) },
  );
  return { status: res.status, json: await res.json(), res };
}

async function storedClinic() {
  const result = await pool.query(
    `SELECT name, timezone, default_locale, enabled_locales, status,
            wilaya_code, commune, address_line
       FROM clinics WHERE id = $1`,
    [ids.clinic],
  );
  return result.rows[0];
}

async function clinicAudits(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text count FROM audit_events
      WHERE clinic_id = $1 AND entity_type = 'clinic'
        AND action = 'clinic.updated'`,
    [ids.clinic],
  );
  return Number(result.rows[0]?.count);
}

const DEFAULT_ROW = {
  name: 'Clinic',
  timezone: 'Africa/Algiers',
  default_locale: 'ar',
  enabled_locales: ['ar', 'fr'],
  status: 'active',
  wilaya_code: null,
  commune: null,
  address_line: null,
};

describe('clinic settings HTTP API (#665)', () => {
  it.each(['cs-admin', 'cs-receptionist', 'cs-doctor'])(
    'returns the staff projection of the clinic to %s',
    async (subject) => {
      const { status, json, res } = await call('GET', subject);
      expect(status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(Object.keys(json)).toEqual(['clinic']);
      const clinic = json.clinic as Record<string, unknown>;
      expect(Object.keys(clinic).sort()).toEqual(CLINIC_KEYS);
      expect(clinic).toEqual({
        id: ids.clinic,
        name: 'Clinic',
        timezone: 'Africa/Algiers',
        defaultLocale: 'ar',
        enabledLocales: ['ar', 'fr'],
        status: 'active',
        wilayaCode: null,
        commune: null,
        addressLine: null,
      });
      expect(JSON.stringify(json)).not.toContain('cs-clinic');
    },
  );

  it('lets the clinic admin rename the clinic, keeping every other setting', async () => {
    const { status, json } = await call('PATCH', 'cs-admin', {
      body: { name: '  Clinique El Amel  ' },
    });
    expect(status).toBe(200);
    expect(Object.keys(json.clinic as object).sort()).toEqual(CLINIC_KEYS);
    expect(json.clinic).toMatchObject({ name: 'Clinique El Amel' });
    expect(await storedClinic()).toEqual({
      ...DEFAULT_ROW,
      name: 'Clinique El Amel',
    });
    expect(await clinicAudits()).toBe(1);
  });

  it('changes the timezone alone and the locale pair alone', async () => {
    const tz = await call('PATCH', 'cs-admin', {
      body: { timezone: 'Europe/Paris' },
    });
    expect(tz.status).toBe(200);
    expect(await storedClinic()).toEqual({
      ...DEFAULT_ROW,
      timezone: 'Europe/Paris',
    });
    const locales = await call('PATCH', 'cs-admin', {
      body: { defaultLocale: 'fr', enabledLocales: ['fr'] },
    });
    expect(locales.status).toBe(200);
    expect(locales.json.clinic).toMatchObject({
      defaultLocale: 'fr',
      enabledLocales: ['fr'],
      timezone: 'Europe/Paris',
    });
    expect(await storedClinic()).toEqual({
      ...DEFAULT_ROW,
      timezone: 'Europe/Paris',
      default_locale: 'fr',
      enabled_locales: ['fr'],
    });
    expect(await clinicAudits()).toBe(2);
  });

  it('rejects an unknown timezone with 400 and writes nothing', async () => {
    const { status, json } = await call('PATCH', 'cs-admin', {
      body: { timezone: 'Mars/Olympus_Mons' },
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_request');
    expect(await storedClinic()).toEqual(DEFAULT_ROW);
    expect(await clinicAudits()).toBe(0);
  });

  it.each([
    ['an empty body', {}],
    ['a blank name', { name: '   ' }],
    ['an overlong name', { name: 'x'.repeat(201) }],
    ['defaultLocale without enabledLocales', { defaultLocale: 'fr' }],
    ['enabledLocales without defaultLocale', { enabledLocales: ['ar'] }],
    [
      'a default outside the enabled locales',
      { defaultLocale: 'fr', enabledLocales: ['ar'] },
    ],
    [
      'a repeated locale',
      { defaultLocale: 'ar', enabledLocales: ['ar', 'ar'] },
    ],
    ['no enabled locale', { defaultLocale: 'ar', enabledLocales: [] }],
    ['an unknown locale', { defaultLocale: 'en', enabledLocales: ['en'] }],
    ['a status change', { status: 'inactive' }],
    ['an extra field', { name: 'Clinic 2', tenantKey: 'other' }],
    ['a non-string name', { name: 42 }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const { status, json } = await call('PATCH', 'cs-admin', { body });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_request');
    expect(await storedClinic()).toEqual(DEFAULT_ROW);
    expect(await clinicAudits()).toBe(0);
  });

  it('rejects a non-JSON body with 400', async () => {
    const { status } = await call('PATCH', 'cs-admin', { raw: 'name=x' });
    expect(status).toBe(400);
    expect(await storedClinic()).toEqual(DEFAULT_ROW);
  });

  it.each(['cs-receptionist', 'cs-doctor', 'cs-other-admin'])(
    'denies the update to %s with 403 and writes nothing',
    async (subject) => {
      const { status, json } = await call('PATCH', subject, {
        body: { name: 'Taken over' },
      });
      expect(status).toBe(403);
      expect(json.error).toBe('forbidden');
      expect(await storedClinic()).toEqual(DEFAULT_ROW);
      expect(await clinicAudits()).toBe(0);
    },
  );

  it("denies another clinic's admin a read with 403", async () => {
    const { status, json } = await call('GET', 'cs-other-admin');
    expect(status).toBe(403);
    expect(json).not.toHaveProperty('clinic');
  });

  it('does not let an admin update another clinic through its id', async () => {
    const { status } = await call('PATCH', 'cs-admin', {
      clinicId: ids.otherClinic,
      body: { name: 'Hijacked' },
    });
    expect(status).toBe(403);
    const other = await pool.query('SELECT name FROM clinics WHERE id = $1', [
      ids.otherClinic,
    ]);
    expect(other.rows[0]?.name).toBe('Other');
  });

  it('rejects a malformed clinic id with 400', async () => {
    const { status } = await call('GET', 'cs-admin', {
      clinicId: 'not-a-uuid',
    });
    expect(status).toBe(400);
  });
});

const LOCATION = {
  wilayaCode: '16',
  commune: 'Bab Ezzouar',
  addressLine: 'Cité 5 Juillet, Bt 12',
};

describe('clinic location over the settings API (#686)', () => {
  it('lets the clinic admin set the location and every staff role read it back', async () => {
    const { status, json } = await call('PATCH', 'cs-admin', {
      body: {
        wilayaCode: '16',
        commune: '  Bab Ezzouar ',
        addressLine: ' Cité 5 Juillet, Bt 12 ',
      },
    });
    expect(status).toBe(200);
    expect(Object.keys(json.clinic as object).sort()).toEqual(CLINIC_KEYS);
    expect(json.clinic).toEqual({
      id: ids.clinic,
      name: 'Clinic',
      timezone: 'Africa/Algiers',
      defaultLocale: 'ar',
      enabledLocales: ['ar', 'fr'],
      status: 'active',
      ...LOCATION,
    });
    expect(await storedClinic()).toEqual({
      ...DEFAULT_ROW,
      wilaya_code: '16',
      commune: 'Bab Ezzouar',
      address_line: 'Cité 5 Juillet, Bt 12',
    });
    expect(await clinicAudits()).toBe(1);
    for (const subject of ['cs-receptionist', 'cs-doctor']) {
      const read = await call('GET', subject);
      expect(read.status).toBe(200);
      expect(read.json.clinic).toMatchObject(LOCATION);
    }
  });

  it('keeps the location on unrelated updates, replaces it as a whole and clears it', async () => {
    await call('PATCH', 'cs-admin', { body: LOCATION });
    const rename = await call('PATCH', 'cs-admin', { body: { name: 'C2' } });
    expect(rename.json.clinic).toMatchObject({ name: 'C2', ...LOCATION });

    const wilayaOnly = await call('PATCH', 'cs-admin', {
      body: { wilayaCode: '31', commune: null, addressLine: null },
    });
    expect(wilayaOnly.status).toBe(200);
    expect(wilayaOnly.json.clinic).toMatchObject({
      wilayaCode: '31',
      commune: null,
      addressLine: null,
    });

    const cleared = await call('PATCH', 'cs-admin', {
      body: { wilayaCode: null, commune: null, addressLine: null },
    });
    expect(cleared.status).toBe(200);
    expect(await storedClinic()).toEqual({ ...DEFAULT_ROW, name: 'C2' });
    expect(await clinicAudits()).toBe(4);
  });

  it.each([
    ['an unknown wilaya code', { ...LOCATION, wilayaCode: '59' }],
    ['the zero wilaya code', { ...LOCATION, wilayaCode: '00' }],
    ['an unpadded wilaya code', { ...LOCATION, wilayaCode: '1' }],
    ['a wilaya name instead of a code', { ...LOCATION, wilayaCode: 'Alger' }],
    ['a numeric wilaya code', { ...LOCATION, wilayaCode: 16 }],
    ['a blank commune', { ...LOCATION, commune: '   ' }],
    ['an overlong commune', { ...LOCATION, commune: 'c'.repeat(101) }],
    ['a blank address', { ...LOCATION, addressLine: '' }],
    ['an overlong address', { ...LOCATION, addressLine: 'a'.repeat(201) }],
    ['a wilaya without commune and address keys', { wilayaCode: '16' }],
    [
      'a commune without the wilaya key',
      { commune: 'Bab Ezzouar', addressLine: null },
    ],
    [
      'a commune without a wilaya',
      { wilayaCode: null, commune: 'Bab Ezzouar', addressLine: null },
    ],
    [
      'an address without a wilaya',
      { wilayaCode: null, commune: null, addressLine: 'Rue 1' },
    ],
    ['a nested location object', { location: LOCATION }],
  ])('rejects %s with 400 and writes nothing', async (_label, body) => {
    const { status, json } = await call('PATCH', 'cs-admin', { body });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_request');
    expect(await storedClinic()).toEqual(DEFAULT_ROW);
    expect(await clinicAudits()).toBe(0);
  });

  it('accepts the maximum commune and address lengths', async () => {
    const { status } = await call('PATCH', 'cs-admin', {
      body: {
        wilayaCode: '58',
        commune: 'c'.repeat(100),
        addressLine: 'a'.repeat(200),
      },
    });
    expect(status).toBe(200);
    expect(await storedClinic()).toMatchObject({
      wilaya_code: '58',
      commune: 'c'.repeat(100),
      address_line: 'a'.repeat(200),
    });
  });

  it.each(['cs-receptionist', 'cs-doctor', 'cs-other-admin'])(
    'denies a location change to %s with 403 and writes nothing',
    async (subject) => {
      const { status } = await call('PATCH', subject, { body: LOCATION });
      expect(status).toBe(403);
      expect(await storedClinic()).toEqual(DEFAULT_ROW);
      expect(await clinicAudits()).toBe(0);
    },
  );

  it("does not let an admin set another clinic's location through its id", async () => {
    const { status } = await call('PATCH', 'cs-admin', {
      clinicId: ids.otherClinic,
      body: LOCATION,
    });
    expect(status).toBe(403);
    const other = await pool.query(
      'SELECT wilaya_code, commune, address_line FROM clinics WHERE id = $1',
      [ids.otherClinic],
    );
    expect(other.rows[0]).toEqual({
      wilaya_code: null,
      commune: null,
      address_line: null,
    });
  });
});
