// TAB-UI-15 (#829): pure helpers for the Médecins et horaires tab
// (docs/design/clinic-setup.md). Bodies mirror addDoctorSchema and
// doctorSpecialtiesSchema.
import {
  MAX_SPECIALTIES_PER_ASSOCIATION,
  isSpecialtyCode,
} from '@/modules/clinic/specialties';

export interface DoctorRow {
  id: string;
  userId: string;
  displayName: string;
  specialtyCodes: string[];
}

export interface MemberRow {
  userId: string;
  displayName: string;
  identifier: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function parseDoctors(raw: unknown): DoctorRow[] | null {
  const list = (raw as { doctors?: unknown } | null)?.doctors;
  if (!Array.isArray(list)) return null;
  const rows: DoctorRow[] = [];
  for (const d of list as Record<string, unknown>[]) {
    if (
      typeof d?.id !== 'string' ||
      typeof d.userId !== 'string' ||
      typeof d.displayName !== 'string' ||
      !Array.isArray(d.specialtyCodes) ||
      !d.specialtyCodes.every((c) => typeof c === 'string')
    )
      return null;
    rows.push({
      id: d.id,
      userId: d.userId,
      displayName: d.displayName,
      specialtyCodes: [...(d.specialtyCodes as string[])],
    });
  }
  return rows;
}

export function parseMembers(raw: unknown): MemberRow[] | null {
  const list = (raw as { memberships?: unknown } | null)?.memberships;
  if (!Array.isArray(list)) return null;
  const rows: MemberRow[] = [];
  for (const m of list as Record<string, unknown>[]) {
    if (
      typeof m?.userId !== 'string' ||
      typeof m.displayName !== 'string' ||
      typeof m.identifier !== 'string'
    )
      return null;
    rows.push({
      userId: m.userId,
      displayName: m.displayName,
      identifier: m.identifier,
    });
  }
  return rows;
}

// Members who are not yet doctors of this clinic: the "add a doctor" choices.
export function eligibleMembers(
  members: MemberRow[],
  doctors: DoctorRow[],
): MemberRow[] {
  const taken = new Set(doctors.map((d) => d.userId));
  return members.filter((m) => !taken.has(m.userId));
}

export type AddDoctorError = 'member_required' | 'name_invalid';

export function buildAddDoctorBody(input: {
  userId: string;
  displayName: string;
}):
  | { ok: true; body: { userId: string; displayName: string } }
  | { ok: false; error: AddDoctorError } {
  if (!UUID.test(input.userId)) return { ok: false, error: 'member_required' };
  const displayName = input.displayName.trim();
  if (
    displayName.length === 0 ||
    displayName.length > 120 ||
    CONTROL.test(displayName)
  )
    return { ok: false, error: 'name_invalid' };
  return { ok: true, body: { userId: input.userId, displayName } };
}

// A fourth specialty is refused (the checkbox is disabled instead).
export function toggleSpecialty(current: string[], code: string): string[] {
  if (current.includes(code)) return current.filter((c) => c !== code);
  if (
    !isSpecialtyCode(code) ||
    current.length >= MAX_SPECIALTIES_PER_ASSOCIATION
  )
    return current;
  return [...current, code];
}

export function buildSpecialtiesBody(
  codes: string[],
): { ok: true; body: { specialtyCodes: string[] } } | { ok: false } {
  if (
    codes.length < 1 ||
    codes.length > MAX_SPECIALTIES_PER_ASSOCIATION ||
    new Set(codes).size !== codes.length ||
    !codes.every(isSpecialtyCode)
  )
    return { ok: false };
  return { ok: true, body: { specialtyCodes: codes } };
}
