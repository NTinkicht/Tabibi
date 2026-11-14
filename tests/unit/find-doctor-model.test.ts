import { describe, expect, it } from 'vitest';
import {
  bookingPath,
  earliestSession,
  filtersQuery,
  findEndpoint,
  parseBookableClinics,
} from '@/app/find/find-model';

const session = (ref: string, startsAt: string) => ({
  serviceDate: startsAt.slice(0, 10),
  startsAt,
  endsAt: startsAt.replace('T08', 'T12'),
  selectionReference: ref,
});
const clinic = (doctors: unknown[]) => ({
  name: 'Clinique A',
  defaultLocale: 'fr',
  enabledLocales: ['fr', 'ar'],
  wilayaCode: '09',
  commune: 'Blida',
  addressLine: '1 rue X',
  doctors,
});

describe('find doctor model', () => {
  it('parses bookable clinics and drops doctors without sessions', () => {
    const parsed = parseBookableClinics({
      clinics: [
        clinic([
          {
            displayName: 'Dr A',
            specialtyCodes: [],
            sessions: [session('v1.abcdefgh.xyz', '2026-11-20T08:00:00Z')],
          },
          { displayName: 'Dr B', specialtyCodes: [], sessions: [] },
        ]),
      ],
    });
    expect(parsed?.[0]?.doctors.map((d) => d.displayName)).toEqual(['Dr A']);
  });

  it.each([
    ['unsafe reference', 'v1/../evil'],
    ['short reference', 'abc'],
  ])('fails closed on %s', (_name, ref) => {
    expect(
      parseBookableClinics({
        clinics: [
          clinic([
            {
              displayName: 'Dr A',
              specialtyCodes: [],
              sessions: [session(ref, '2026-11-20T08:00:00Z')],
            },
          ]),
        ],
      }),
    ).toBeNull();
  });

  it('fails closed on an unknown specialty code or wilaya', () => {
    const doctor = {
      displayName: 'Dr A',
      specialtyCodes: ['nope'],
      sessions: [],
    };
    expect(parseBookableClinics({ clinics: [clinic([doctor])] })).toBeNull();
    expect(
      parseBookableClinics({
        clinics: [{ ...clinic([]), wilayaCode: '99' }],
      }),
    ).toBeNull();
  });

  it('builds endpoints only from controlled filter values', () => {
    expect(
      findEndpoint(
        'book',
        { specialty: 'bad<', wilaya: '09', language: 'ar' },
        2,
      ),
    ).toBe('/api/public/bookable-sessions?wilaya=09&language=ar&page=2');
    expect(
      findEndpoint(
        'directory',
        { specialty: '', wilaya: '', language: 'all' },
        1,
      ),
    ).toBe('/api/public/discovery');
    expect(filtersQuery({ specialty: '', wilaya: '', language: 'fr' }, 1)).toBe(
      '?language=fr',
    );
  });

  it('picks the earliest session and encodes the booking route', () => {
    const doctor = {
      displayName: 'Dr A',
      specialtyCodes: [],
      sessions: [
        session('v1.bbbbbbbb.x', '2026-11-21T08:00:00Z'),
        session('v1.aaaaaaaa.x', '2026-11-20T08:00:00Z'),
      ],
    };
    const first = earliestSession(doctor);
    expect(first?.selectionReference).toBe('v1.aaaaaaaa.x');
    expect(first && bookingPath(first)).toBe('/guest/live-queue/v1.aaaaaaaa.x');
  });
});
