import { describe, expect, it } from 'vitest';
import {
  INVITE_ROLES,
  inviteLink,
  parseCreatedInvite,
  parseInvites,
  parseStaff,
  patchBody,
  planRoleChange,
  removalConflict,
  sortStaff,
} from '@/app/operations/[clinicId]/settings/staff-model';
import { membershipRoleSchema } from '@/platform/http/scheduling-input';

// TAB-UI-16 (#830): the members table only sends bodies the server accepts.
const row = (userId: string, displayName: string, role = 'receptionist') => ({
  userId,
  displayName,
  identifier: `${userId}@x`,
  role,
});

describe('parseStaff', () => {
  it('accepts the API shape and rejects unknown roles or missing fields', () => {
    expect(parseStaff({ memberships: [row('u1', 'A')] })).toHaveLength(1);
    expect(parseStaff({ memberships: [row('u1', 'A', 'owner')] })).toBeNull();
    expect(
      parseStaff({ memberships: [{ userId: 'u1', role: 'doctor' }] }),
    ).toBeNull();
    expect(parseStaff({})).toBeNull();
  });
});

describe('sortStaff', () => {
  it('sorts by name with userId as a stable tie-break and does not mutate', () => {
    const input = parseStaff({
      memberships: [row('u3', 'Zed'), row('u2', 'Amel'), row('u1', 'Amel')],
    })!;
    const sorted = sortStaff(input, 'fr');
    expect(sorted.map((m) => m.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(input[0].userId).toBe('u3');
  });
});

describe('planRoleChange', () => {
  it('maps each transition to the documented flow', () => {
    expect(planRoleChange('doctor', 'doctor')).toEqual({ kind: 'none' });
    expect(planRoleChange('receptionist', 'clinic_admin')).toEqual({
      kind: 'patch',
      role: 'clinic_admin',
    });
    expect(planRoleChange('receptionist', 'doctor')).toEqual({
      kind: 'add_doctor',
    });
    expect(planRoleChange('clinic_admin', 'doctor')).toEqual({
      kind: 'add_doctor',
    });
    expect(planRoleChange('doctor', 'receptionist')).toEqual({
      kind: 'confirm_leave_doctor',
      role: 'receptionist',
    });
  });

  it('only ever sends PATCH bodies the server schema accepts', () => {
    for (const role of ['clinic_admin', 'receptionist'] as const) {
      expect(membershipRoleSchema.safeParse(patchBody(role)).success).toBe(
        true,
      );
    }
  });
});

describe('removalConflict', () => {
  it('names the 409 reason from the removed member role', () => {
    expect(removalConflict('clinic_admin')).toBe('last_admin');
    expect(removalConflict('doctor')).toBe('doctor_without_profile');
  });
});

describe('invites', () => {
  const invite = (over: Record<string, unknown> = {}) => ({
    inviteId: 'i1',
    email: 'a@x.dz',
    role: 'doctor',
    status: 'expired',
    expiresAt: '2026-11-01T00:00:00.000Z',
    ...over,
  });

  it('parses the list and rejects an unknown role or status', () => {
    expect(parseInvites({ invites: [invite()] })).toHaveLength(1);
    expect(
      parseInvites({ invites: [invite({ role: 'clinic_admin' })] }),
    ).toBeNull();
    expect(
      parseInvites({ invites: [invite({ status: 'accepted' })] }),
    ).toBeNull();
    expect(parseInvites({})).toBeNull();
  });

  it('never offers administrator as an invite role', () => {
    expect(INVITE_ROLES).toEqual(['receptionist', 'doctor']);
  });

  it('puts the token in the fragment only', () => {
    const link = inviteLink('https://app.tabibi.dz', 'abc');
    expect(link).toBe('https://app.tabibi.dz/staff/invite#abc');
    expect(new URL(link).search).toBe('');
    expect(new URL(link).hash).toBe('#abc');
  });

  it('reads the created invite and rejects a response without a token', () => {
    expect(
      parseCreatedInvite({ invite: { inviteId: 'i1', token: 'abc' } }),
    ).toEqual({ inviteId: 'i1', token: 'abc' });
    expect(parseCreatedInvite({ invite: { inviteId: 'i1' } })).toBeNull();
  });
});
