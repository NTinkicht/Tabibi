import { beforeEach, describe, expect, it, vi } from 'vitest';

const listClinics = vi.fn();

vi.mock('@/modules/clinic', () => ({
  PublicDiscoveryService: class {
    listClinics() {
      return listClinics();
    }
  },
}));

vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));
vi.mock('@/platform/observability/logger', () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { GET } from '@/app/api/public/discovery/route';

function request(): Request {
  return new Request('https://tabibi.test/api/public/discovery', {
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
        doctors: [
          {
            displayName: 'Dr. Amel Benali',
            id: 'private-doctor-id',
            userId: 'private-user-id',
          },
          {
            displayName: 'د. سارة',
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
          doctors: [
            { displayName: 'Dr. Amel Benali' },
            { displayName: 'د. سارة' },
          ],
        },
      ],
    });
  });

  it('returns a successful empty discovery result', async () => {
    listClinics.mockResolvedValue([]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clinics: [] });
  });
});
