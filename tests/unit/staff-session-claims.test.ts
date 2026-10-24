import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('@/platform/database/pool', () => ({
  getPool: () => ({ query }),
}));

import {
  authenticatedClinicScope,
  createStaffSessionToken,
  StaffAuthenticationError,
} from '@/platform/http/staff-auth';

// TAB-P0-01 session-expiry, claim-shape and duplicate-cookie negatives (#628).
const SECRET = 'staff-session-claims-unit-test-only-secret-0123456789';
const CLINIC_ID = '00000000-0000-4000-8000-000000000001';
const STAFF_USER_ID = '00000000-0000-4000-8000-0000000000a1';
const NOW_MS = Date.UTC(2026, 9, 18, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const SID = 'synthetic-session-identifier';

// Issues through a stub store so token creation never touches the mocked
// pool: the pool mock then counts only authentication lookups.
const issuingStore = {
  query: async () => ({ rows: [{ user_id: STAFF_USER_ID }] }),
};
function issue(subject: string, expiresAt: Date): Promise<string> {
  return createStaffSessionToken(subject, expiresAt, issuingStore as never);
}

function signRaw(json: string): string {
  const payload = Buffer.from(json).toString('base64url');
  const signature = createHmac('sha256', SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function request(cookie: string): Request {
  return new Request('http://localhost:3000/api/clinics/example/sessions', {
    headers: { cookie },
  });
}

async function expectRejectedWithoutLookup(cookie: string): Promise<void> {
  await expect(
    authenticatedClinicScope(request(cookie), CLINIC_ID),
  ).rejects.toBeInstanceOf(StaffAuthenticationError);
  expect(query).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  vi.stubEnv('STAFF_SESSION_SECRET', SECRET);
  query.mockReset();
  query.mockResolvedValue({ rows: [{ id: STAFF_USER_ID }] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('staff session expiry', () => {
  it('accepts a single unexpired session cookie (positive control)', async () => {
    const token = await issue(
      'synthetic-staff-subject',
      new Date(NOW_MS + 1_000),
    );
    await expect(
      authenticatedClinicScope(
        request(`other=1; tabibi_staff_session=${token}`),
        CLINIC_ID,
      ),
    ).resolves.toEqual({ clinicId: CLINIC_ID, actorUserId: STAFF_USER_ID });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual([
      expect.any(Buffer),
      'synthetic-staff-subject',
    ]);
  });

  it('rejects an expired token and a token at its exact expiry second', async () => {
    for (const expiresAt of [NOW_MS - 60_000, NOW_MS - 1_000, NOW_MS]) {
      const token = await issue('synthetic-staff-subject', new Date(expiresAt));
      await expectRejectedWithoutLookup(`tabibi_staff_session=${token}`);
    }
  });

  it('starts rejecting a token once the clock reaches its expiry', async () => {
    const token = await issue(
      'synthetic-staff-subject',
      new Date(NOW_MS + 1_000),
    );
    vi.setSystemTime(NOW_MS + 1_000);
    await expectRejectedWithoutLookup(`tabibi_staff_session=${token}`);
  });
});

describe('staff session claim shape', () => {
  const future = NOW_S + 3_600;

  it.each([
    [
      'string exp',
      { sub: 'synthetic-staff-subject', sid: SID, exp: String(future) },
    ],
    ['array exp', { sub: 'synthetic-staff-subject', sid: SID, exp: [future] }],
    [
      'fractional exp',
      { sub: 'synthetic-staff-subject', sid: SID, exp: future + 0.5 },
    ],
    [
      'unsafe integer exp',
      { sub: 'synthetic-staff-subject', sid: SID, exp: 2 ** 60 },
    ],
    ['null exp', { sub: 'synthetic-staff-subject', sid: SID, exp: null }],
    ['missing exp', { sub: 'synthetic-staff-subject', sid: SID }],
    ['empty sub', { sub: '', sid: SID, exp: future }],
    ['numeric sub', { sub: 42, sid: SID, exp: future }],
    ['missing sub', { sid: SID, exp: future }],
    // Pre-revocation `{sub, exp}` tokens have no session identifier (#634).
    ['missing sid', { sub: 'synthetic-staff-subject', exp: future }],
    ['empty sid', { sub: 'synthetic-staff-subject', sid: '', exp: future }],
    ['numeric sid', { sub: 'synthetic-staff-subject', sid: 7, exp: future }],
    ['array sid', { sub: 'synthetic-staff-subject', sid: [SID], exp: future }],
  ])('rejects a signed token with %s', async (_label, claims) => {
    await expectRejectedWithoutLookup(
      `tabibi_staff_session=${signRaw(JSON.stringify(claims))}`,
    );
  });

  it.each([
    ['null', 'null'],
    ['array', JSON.stringify(['synthetic-staff-subject', future])],
    ['string', JSON.stringify('synthetic-staff-subject')],
    ['number', String(future)],
    ['non-JSON', 'not-json'],
  ])('rejects a signed %s payload', async (_label, json) => {
    await expectRejectedWithoutLookup(`tabibi_staff_session=${signRaw(json)}`);
  });
});

describe('staff session cookie cardinality', () => {
  function validToken(subject: string): Promise<string> {
    return issue(subject, new Date(NOW_MS + 60_000));
  }

  it('rejects a request without a session cookie or with an empty one', async () => {
    await expectRejectedWithoutLookup('other=1');
    await expectRejectedWithoutLookup('tabibi_staff_session=');
  });

  it('rejects duplicate session cookies whatever their order or validity', async () => {
    const victim = await validToken('synthetic-victim-subject');
    const planted = await validToken('synthetic-planted-subject');
    const forged = `${(await validToken('synthetic-forged')).split('.')[0]}.not-the-signature`;
    for (const cookie of [
      `tabibi_staff_session=${planted}; tabibi_staff_session=${victim}`,
      `tabibi_staff_session=${victim}; tabibi_staff_session=${forged}`,
      `tabibi_staff_session=${forged}; tabibi_staff_session=${victim}`,
      `tabibi_staff_session=${victim}; tabibi_staff_session=${victim}`,
      `tabibi_staff_session=${victim}; tabibi_staff_session=`,
    ]) {
      await expectRejectedWithoutLookup(cookie);
    }
  });

  it('does not treat a cookie with a longer name as a session cookie', async () => {
    const token = await validToken('synthetic-staff-subject');
    const other = await validToken('synthetic-other');
    await expect(
      authenticatedClinicScope(
        request(
          `tabibi_staff_session_old=${other}; tabibi_staff_session=${token}`,
        ),
        CLINIC_ID,
      ),
    ).resolves.toEqual({ clinicId: CLINIC_ID, actorUserId: STAFF_USER_ID });
    expect(query.mock.calls[0]?.[1]).toEqual([
      expect.any(Buffer),
      'synthetic-staff-subject',
    ]);
  });
});
