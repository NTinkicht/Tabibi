import { describe, expect, it } from 'vitest';
import {
  buildAddDoctorBody,
  buildSpecialtiesBody,
  eligibleMembers,
  parseDoctors,
  parseMembers,
  toggleSpecialty,
} from '@/app/operations/[clinicId]/settings/doctor-model';
import {
  addDoctorSchema,
  doctorSpecialtiesSchema,
} from '@/platform/http/scheduling-input';

// TAB-UI-15 (#829): the doctors tab only sends bodies the server accepts.
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('parseDoctors / parseMembers', () => {
  it('accepts the API shapes and rejects malformed rows', () => {
    expect(
      parseDoctors({
        doctors: [
          {
            id: 'd1',
            userId: U1,
            displayName: 'Dr A',
            specialtyCodes: ['ent'],
          },
        ],
      }),
    ).toEqual([
      { id: 'd1', userId: U1, displayName: 'Dr A', specialtyCodes: ['ent'] },
    ]);
    expect(parseDoctors({ doctors: [{ id: 'd1' }] })).toBeNull();
    expect(parseDoctors({})).toBeNull();
    expect(
      parseMembers({
        memberships: [{ userId: U1, displayName: 'A', identifier: 'a@x' }],
      }),
    ).toHaveLength(1);
    expect(parseMembers({ memberships: [{ userId: U1 }] })).toBeNull();
  });
});

describe('eligibleMembers', () => {
  it('excludes members who are already doctors', () => {
    const members = [
      { userId: U1, displayName: 'A', identifier: 'a' },
      { userId: U2, displayName: 'B', identifier: 'b' },
    ];
    const doctors = [
      { id: 'd1', userId: U1, displayName: 'A', specialtyCodes: [] },
    ];
    expect(eligibleMembers(members, doctors).map((m) => m.userId)).toEqual([
      U2,
    ]);
  });
});

describe('buildAddDoctorBody', () => {
  it('trims and produces a body the server schema accepts', () => {
    const r = buildAddDoctorBody({ userId: U1, displayName: '  Dr Amine ' });
    expect(r).toEqual({
      ok: true,
      body: { userId: U1, displayName: 'Dr Amine' },
    });
    if (r.ok) expect(addDoctorSchema.safeParse(r.body).success).toBe(true);
  });
  it('refuses a missing member, a blank/overlong/control name', () => {
    expect(buildAddDoctorBody({ userId: '', displayName: 'x' })).toEqual({
      ok: false,
      error: 'member_required',
    });
    for (const displayName of ['   ', 'a'.repeat(121), 'a\u0007b']) {
      expect(buildAddDoctorBody({ userId: U1, displayName })).toEqual({
        ok: false,
        error: 'name_invalid',
      });
    }
  });
});

describe('specialties', () => {
  it('toggles, and refuses a fourth or unknown code', () => {
    let s: string[] = [];
    for (const c of ['ent', 'pediatrics', 'cardiology'])
      s = toggleSpecialty(s, c);
    expect(s).toEqual(['ent', 'pediatrics', 'cardiology']);
    expect(toggleSpecialty(s, 'dentistry')).toEqual(s);
    expect(toggleSpecialty(s, 'ent')).toEqual(['pediatrics', 'cardiology']);
    expect(toggleSpecialty([], 'not_a_code')).toEqual([]);
  });
  it('builds only bodies the server schema accepts', () => {
    const ok = buildSpecialtiesBody(['ent']);
    expect(ok.ok).toBe(true);
    if (ok.ok)
      expect(doctorSpecialtiesSchema.safeParse(ok.body).success).toBe(true);
    expect(buildSpecialtiesBody([])).toEqual({ ok: false });
    expect(buildSpecialtiesBody(['ent', 'ent'])).toEqual({ ok: false });
    expect(
      buildSpecialtiesBody(['ent', 'pediatrics', 'cardiology', 'dentistry']),
    ).toEqual({ ok: false });
    expect(buildSpecialtiesBody(['nope'])).toEqual({ ok: false });
  });
});
