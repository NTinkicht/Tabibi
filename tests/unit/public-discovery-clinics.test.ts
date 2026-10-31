import { describe, expect, it } from 'vitest';
import {
  clinicLocation,
  doctorSpecialties,
  parsePublicClinics,
  specialtyName,
  wilayaName,
} from '@/app/public-discovery-clinics';

// TAB-P0-03 (#698): the landing refresh keeps exactly the public clinic
// allow-list, including location and doctor specialties, and fails closed on
// anything outside the versioned lists.
const clinic = (overrides: Record<string, unknown> = {}) => ({
  name: 'Clinique des Pins',
  defaultLocale: 'fr',
  enabledLocales: ['fr', 'ar'],
  wilayaCode: '16',
  commune: 'Hydra',
  addressLine: '12 rue des Pins',
  doctors: [{ displayName: 'Dr. Amel', specialtyCodes: ['cardiology'] }],
  ...overrides,
});

describe('parsePublicClinics', () => {
  it('keeps exactly the public allow-list fields', () => {
    const parsed = parsePublicClinics({
      page: 1,
      hasMore: false,
      clinics: [
        clinic({
          id: 'clinic-id',
          tenantKey: 'tenant',
          doctors: [
            {
              displayName: 'Dr. Amel',
              specialtyCodes: ['cardiology', 'pediatrics'],
              id: 'doctor-id',
            },
          ],
        }),
      ],
    });
    expect(parsed).toStrictEqual([
      {
        name: 'Clinique des Pins',
        defaultLocale: 'fr',
        enabledLocales: ['fr', 'ar'],
        wilayaCode: '16',
        commune: 'Hydra',
        addressLine: '12 rue des Pins',
        doctors: [
          {
            displayName: 'Dr. Amel',
            specialtyCodes: ['cardiology', 'pediatrics'],
          },
        ],
      },
    ]);
  });

  it('reads absent or null location and specialties as not published', () => {
    const parsed = parsePublicClinics({
      clinics: [
        {
          name: 'Cabinet',
          defaultLocale: 'ar',
          enabledLocales: ['ar'],
          doctors: [{ displayName: 'Dr. Salim' }],
        },
        clinic({ wilayaCode: null, commune: null, addressLine: null }),
        clinic({ commune: null, addressLine: null }),
      ],
    });
    expect(parsed?.[0]).toStrictEqual({
      name: 'Cabinet',
      defaultLocale: 'ar',
      enabledLocales: ['ar'],
      wilayaCode: null,
      commune: null,
      addressLine: null,
      doctors: [{ displayName: 'Dr. Salim', specialtyCodes: [] }],
    });
    expect(parsed?.[1]).toMatchObject({
      wilayaCode: null,
      commune: null,
      addressLine: null,
    });
    expect(parsed?.[2]).toMatchObject({
      wilayaCode: '16',
      commune: null,
      addressLine: null,
    });
  });

  it.each([
    ['unknown wilaya code', { wilayaCode: '59' }],
    ['numeric wilaya code', { wilayaCode: 16 }],
    ['empty wilaya code', { wilayaCode: '' }],
    ['non-string commune', { commune: 7 }],
    ['empty address', { addressLine: '' }],
    ['commune without wilaya', { wilayaCode: null, addressLine: null }],
    ['address without wilaya', { wilayaCode: null, commune: null }],
    [
      'unknown specialty code',
      { doctors: [{ displayName: 'Dr. X', specialtyCodes: ['astrology'] }] },
    ],
    [
      'non-array specialties',
      { doctors: [{ displayName: 'Dr. X', specialtyCodes: 'cardiology' }] },
    ],
    [
      'null specialties',
      { doctors: [{ displayName: 'Dr. X', specialtyCodes: null }] },
    ],
    ['non-string doctor name', { doctors: [{ displayName: 3 }] }],
    ['unknown locale', { enabledLocales: ['en'] }],
  ])('rejects the whole page for %s', (_label, overrides) => {
    expect(
      parsePublicClinics({ clinics: [clinic(), clinic(overrides)] }),
    ).toBeNull();
  });

  it('rejects a body without a clinics array', () => {
    expect(parsePublicClinics(null)).toBeNull();
    expect(parsePublicClinics({})).toBeNull();
    expect(parsePublicClinics({ clinics: 'x' })).toBeNull();
  });
});

describe('public discovery labels', () => {
  it('localizes wilaya and specialty codes in Arabic and French', () => {
    expect(wilayaName('16', 'fr')).toBe('Alger');
    expect(wilayaName('16', 'ar')).toBe('الجزائر');
    expect(specialtyName('pediatrics', 'fr')).toBe('Pédiatrie');
    expect(specialtyName('pediatrics', 'ar')).toBe('طب الأطفال');
  });

  it('never invents a label for an unknown code', () => {
    expect(wilayaName('99', 'fr')).toBeNull();
    expect(specialtyName('astrology', 'ar')).toBeNull();
  });
});

describe('public clinic card text', () => {
  const parsed = parsePublicClinics({ clinics: [clinic()] })![0];

  it('formats the location most specific first in both languages', () => {
    expect(clinicLocation(parsed, 'fr')).toBe('12 rue des Pins, Hydra, Alger');
    expect(clinicLocation(parsed, 'ar')).toBe(
      '12 rue des Pins، Hydra، الجزائر',
    );
    expect(
      clinicLocation({ ...parsed, commune: null, addressLine: null }, 'fr'),
    ).toBe('Alger');
    expect(clinicLocation({ ...parsed, wilayaCode: null }, 'fr')).toBeNull();
    expect(clinicLocation({ ...parsed, wilayaCode: '99' }, 'fr')).toBeNull();
  });

  it('lists localized specialties and omits unknown codes', () => {
    const doctor = {
      displayName: 'Dr. Amel',
      specialtyCodes: ['cardiology', 'astrology', 'ent'],
    };
    expect(doctorSpecialties(doctor, 'fr')).toBe('Cardiologie, ORL');
    expect(doctorSpecialties(doctor, 'ar')).toBe(
      'أمراض القلب، أمراض الأنف والأذن والحنجرة',
    );
    expect(
      doctorSpecialties({ displayName: 'Dr. X', specialtyCodes: [] }, 'fr'),
    ).toBeNull();
  });
});
