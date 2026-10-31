import { beforeEach, describe, expect, it, vi } from 'vitest';

const listClinics = vi.fn();

vi.mock('@/modules/clinic', () => ({
  PublicDiscoveryService: class {
    listClinics(...args: unknown[]) {
      return listClinics(...args);
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
    listClinics.mockReset();
  });

  it('returns only the public discovery allow-list and no-store headers', async () => {
    listClinics.mockResolvedValue([
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
    });
    expect(listClinics).toHaveBeenCalledWith(
      undefined,
      expect.any(AbortSignal),
      {},
    );
  });

  it('serializes an unset clinic location as explicit nulls', async () => {
    listClinics.mockResolvedValue([
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
    });
  });

  it('passes validated wilaya and specialty filters to the discovery service', async () => {
    listClinics.mockResolvedValue([]);

    for (const [query, filters] of [
      ['?wilaya=16', { wilayaCode: '16' }],
      ['?specialty=pediatrics', { specialtyCode: 'pediatrics' }],
      [
        '?specialty=cardiology&wilaya=31',
        { wilayaCode: '31', specialtyCode: 'cardiology' },
      ],
    ] as const) {
      listClinics.mockClear();
      const response = await GET(request(query));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ clinics: [] });
      expect(listClinics).toHaveBeenCalledWith(
        undefined,
        expect.any(AbortSignal),
        filters,
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
      '?wilaya=16&page=2',
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
    expect(listClinics).not.toHaveBeenCalled();
  });

  it('never serializes sensitive fields added by the discovery service', async () => {
    listClinics.mockResolvedValue([
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
    listClinics.mockResolvedValue([]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clinics: [] });
  });

  it('bounds a stalled discovery query and returns a retryable privacy-safe error', async () => {
    let querySignal: AbortSignal | undefined;
    listClinics.mockImplementation((_timeout: unknown, signal: AbortSignal) => {
      querySignal = signal;
      return new Promise<never>(() => {});
    });

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
