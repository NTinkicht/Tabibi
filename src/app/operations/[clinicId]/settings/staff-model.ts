// TAB-UI-16 (#830): pure helpers of the Personnel tab members table
// (docs/design/clinic-setup.md, Personnel tab). No copy here.

export type StaffRole = 'clinic_admin' | 'receptionist' | 'doctor';
export const STAFF_ROLES: readonly StaffRole[] = [
  'clinic_admin',
  'receptionist',
  'doctor',
];

export interface StaffMember {
  userId: string;
  displayName: string;
  identifier: string;
  role: StaffRole;
}

export function parseStaff(raw: unknown): StaffMember[] | null {
  const list = (raw as { memberships?: unknown } | null)?.memberships;
  if (!Array.isArray(list)) return null;
  const rows: StaffMember[] = [];
  for (const m of list as Record<string, unknown>[]) {
    if (
      typeof m?.userId !== 'string' ||
      typeof m.displayName !== 'string' ||
      typeof m.identifier !== 'string' ||
      !STAFF_ROLES.includes(m.role as StaffRole)
    )
      return null;
    rows.push({
      userId: m.userId,
      displayName: m.displayName,
      identifier: m.identifier,
      role: m.role as StaffRole,
    });
  }
  return rows;
}

// "sorted by name in the UI": locale-aware, userId as the stable tie-break.
export function sortStaff(rows: StaffMember[], locale: string): StaffMember[] {
  const collator = new Intl.Collator(locale);
  return [...rows].sort(
    (a, b) =>
      collator.compare(a.displayName, b.displayName) ||
      a.userId.localeCompare(b.userId),
  );
}

export type RoleChange =
  | { kind: 'none' }
  | { kind: 'patch'; role: 'clinic_admin' | 'receptionist' }
  // Becoming a doctor needs a doctor profile: handled by "add a doctor".
  | { kind: 'add_doctor' }
  // Leaving the doctor role leaves discovery and booking: confirm first.
  | { kind: 'confirm_leave_doctor'; role: 'clinic_admin' | 'receptionist' };

export function planRoleChange(from: StaffRole, to: StaffRole): RoleChange {
  if (from === to) return { kind: 'none' };
  if (to === 'doctor') return { kind: 'add_doctor' };
  if (from === 'doctor') return { kind: 'confirm_leave_doctor', role: to };
  return { kind: 'patch', role: to };
}

export type RemovalConflict = 'last_admin' | 'doctor_without_profile';

// Both conflicts are the same 409 'conflict' code, so the reason is derived
// from the member the admin asked to remove: only an admin can be the last
// admin, and only a doctor can lack a profile.
export function removalConflict(role: StaffRole): RemovalConflict {
  return role === 'doctor' ? 'doctor_without_profile' : 'last_admin';
}

export function patchBody(role: 'clinic_admin' | 'receptionist') {
  return { role };
}
