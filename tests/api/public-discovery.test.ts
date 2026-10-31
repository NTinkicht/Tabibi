import { beforeEach, describe, expect, it, vi } from 'vitest';

const listClinicsPage = vi.fn();
const mockPage = (clinics: unknown[], hasMore = false) =>
  listClinicsPage.mockResolvedValue({ clinics, hasMore });

vi.mock('@/modules/clinic', () => ({
  PublicDiscoveryService: class {
    listClinicsPage(...args: unknown[]) {
      return listClinicsPage(...args);
    }
  },
}));

vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { GET } from '@/app/api/public/discovery/route';

function request(query = ''): Request {
  return new Request(`https://tabibi.test/api/public/discovery${query}`, {
    headers: { 'x-request-id': 'wu74-public-discovery-1' },
  });
}

describe('GET /api/public/discovery', () => {
  beforeEach(() => {
    listClinicsPage.mockReset();
  });

  it('returns only the public discovery allow-list and no-store headers', async () => {
    mockPage([
      {
        name: 'Clinique El Amal',
        defaultLocale: 'fr',
        enabledLocales: ['fr', 'ar'],
        tenantKey: 'must-never-serialize',
        id: 'private-clinic-id',
        wilayaCode: '16',
        commune: 'Bab Ezzouar',
        addressLine: '12 rue des Frères Bouadou',
        timezone: 'Africa/Algiers',
        doctors: [
          {
            displayName: 'Dr. Amel Benali',
            specialtyCodes: ['cardiology', 'internal_medicine'],
            id: 'private-doctor-id',
            userId: 'private-user-id',
          },
          {
            displayName: 'د. سارة',
            specialtyCodes: [],
            membershipRole: 'clinic_admin',
          },
        ],
      },
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe(
      'wu74-public-discovery-1',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.json()).toEqual({
      clinics: [
        {
          name: 'Clinique El Amal',
          defaultLocale: 'fr',
          enabledLocales: ['fr', 'ar'],
          wilayaCode: '16',
          commune: 'Bab Ezzouar',
          addressLine: '12 rue des Frères Bouadou',
          doctors: [
            {
              displayName: 'Dr. Amel Benali',
              specialtyCodes: ['cardiology', 'internal_medicine'],
            },
            { displayName: 'د. سارة', specialtyCodes: [] },
          ],
        },
      ],
      page: 1,
      hasMore: false,
    });
    expect(listClinicsPage).toHaveBeenCalledWith(
      undefined,
      expect.any(AbortSignal),
      {},
      1,
    );
  });

  it('serializes an unset clinic location as explicit nulls', async () => {
    mockPage([
      {
        name: 'Clinique Sans Adresse',
        defaultLocale: 'ar',
        enabledLocales: ['ar'],
        wilayaCode: null,
        commune: null,
        addressLine: null,
        doctors: [],
      },
    ]);

    const response = await GET(request());

    expect(await response.json()).toEqual({
      clinics: [
        {
          name: 'Clinique Sans Adresse',
          defaultLocale: 'ar',
          enabledLocales: ['ar'],
          wilayaCode: null,
          commune: null,
          addressLine: null,
          doctors: [],
        },
      ],
      page: 1,
      hasMore: false,
    });
  });

  it('passes validated wilaya and specialty filters to the discovery service', async () => {
    mockPage([]);

    for (const [query, filters] of [
      ['?wilaya=16', { wilayaCode: '16' }],
      ['?specialty=pediatrics', { specialtyCode: 'pediatrics' }],
      [
        '?specialty=cardiology&wilaya=31',
        { wilayaCode: '31', specialtyCode: 'cardiology' },
      ],
      ['?available=true', { availableOnly: true }],
      [
        '?wilaya=16&available=true&specialty=ent',
        { wilayaCode: '16', specialtyCode: 'ent', availableOnly: true },
      ],
    ] as const) {
      listClinicsPage.mockClear();
      const response = await GET(request(query));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        clinics: [],
        page: 1,
        hasMore: false,
      });
      expect(listClinicsPage).toHaveBeenCalledWith(
        undefined,
        expect.any(AbortSignal),
        filters,
        1,
      );
    }
  });

  it('rejects unknown, repeated, empty or uncontrolled filters without querying', async () => {
    for (const query of [
      '?wilaya=59',
      '?wilaya=1',
      '?wilaya=',
      '?wilaya=16&wilaya=31',
      '?specialty=Cardiology',
      '?specialty=',
      '?specialty=cardiology&specialty=ent',
      '?speciality=cardiology',
      '?language=fr',
      '?available=false',
      '?available=1',
      '?available=TRUE',
      '?available=',
      '?available',
      '?available=true&available=true',
      '?availability=true',
    ]) {
      const response = await GET(request(query));
      expect(response.status, query).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.json()).toEqual({
        status: 'rejected',
        requestId: 'wu74-public-discovery-1',
      });
    }
    expect(listClinicsPage).not.toHaveBeenCalled();
  });

  it('passes a validated page and reports only page and hasMore', async () => {
    mockPage([], true);

    for (const [query, filters, page] of [
      ['?page=1', {}, 1],
      ['?page=2', {}, 2],
      ['?page=500', {}, 500],
      [
        '?wilaya=16&page=7&available=true',
        { wilayaCode: '16', availableOnly: true },
        7,
      ],
    ] as const) {
      listClinicsPage.mockClear();
      const response = await GET(request(query));
      expect(response.status, query).toBe(200);
      expect(await response.json()).toEqual({
        clinics: [],
        page,
        hasMore: true,
      });
      expect(listClinicsPage).toHaveBeenCalledWith(
        undefined,
        expect.any(AbortSignal),
        filters,
        page,
      );
    }
  });

  it('rejects malformed, repeated or out-of-range pages without querying', async () => {
    for (const query of [
      '?page=0',
      '?page=-1',
      '?page=+1',
      '?page=01',
      '?page=1.0',
      '?page=1e2',
      '?page=0x10',
      '?page= 1',
      '?page=',
      '?page',
      '?page=501',
      '?page=1000',
      '?page=1&page=2',
      '?pageSize=50',
      '?limit=50',
      '?offset=20',
    ]) {
      const response = await GET(request(query));
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({
        status: 'rejected',
        requestId: 'wu74-public-discovery-1',
      });
    }
    expect(listClinicsPage).not.toHaveBeenCalled();
  });

  it('never serializes sensitive fields added by the discovery service', async () => {
    mockPage([
      {
        name: 'Public Clinic',
        defaultLocale: 'en',
        enabledLocales: ['en'],
        id: 'clinic-secret',
        tenantKey: 'tenant-secret',
        internalNotes: 'private-clinic-notes',
        doctors: [
          {
            displayName: 'Dr. Public',
            id: 'doctor-secret',
            userId: 'user-secret',
            membershipRole: 'clinic_admin',
            internalNotes: 'private-doctor-notes',
          },
        ],
      },
    ]);

    const response = await GET(request());
    const body = JSON.stringify(await response.json());

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    for (const secret of [
      'clinic-secret',
      'tenant-secret',
      'private-clinic-notes',
      'doctor-secret',
      'user-secret',
      'clinic_admin',
      'private-doctor-notes',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('returns a successful empty discovery result', async () => {
    mockPage([]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      clinics: [],
      page: 1,
      hasMore: false,
    });
  });

  it('bounds a stalled discovery query and returns a retryable privacy-safe error', async () => {
    let querySignal: AbortSignal | undefined;
    listClinicsPage.mockImplementation(
      (_timeout: unknown, signal: AbortSignal) => {
        querySignal = signal;
        return new Promise<never>(() => {});
      },
    );

    vi.useFakeTimers();
    try {
      const pending = GET(request());
      await vi.advanceTimersByTimeAsync(2_000);
      const response = await pending;

      expect(querySignal?.aborted).toBe(true);
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.json()).toEqual({
        status: 'error',
        requestId: 'wu74-public-discovery-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
