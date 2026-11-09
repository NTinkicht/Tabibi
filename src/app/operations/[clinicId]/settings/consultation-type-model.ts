// TAB-UI-15 (#829): pure helpers for the Types de consultation section
// (docs/design/clinic-setup.md). Bodies mirror createConsultationTypeSchema.
export interface ConsultationTypeRow {
  id: string;
  code: string;
  label: string;
  nominalDurationMinutes: number;
  active: boolean;
}

export type NewTypeError =
  | 'label_required'
  | 'code_invalid'
  | 'duration_invalid';

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const DURATION_MIN = 5;
export const DURATION_MAX = 240;

// Code suggested from the label: lower-case ASCII, accents folded, other runs
// replaced by "-", at most 48 characters. May be empty (e.g. Arabic-only
// label), in which case the admin types a code.
export function suggestCode(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

export function buildNewTypeBody(input: {
  label: string;
  code: string;
  duration: string;
}):
  | {
      ok: true;
      body: { code: string; label: string; nominalDurationMinutes: number };
    }
  | { ok: false; error: NewTypeError } {
  const label = input.label.trim();
  if (label.length === 0 || label.length > 80)
    return { ok: false, error: 'label_required' };
  const code = input.code.trim();
  if (!CODE_PATTERN.test(code)) return { ok: false, error: 'code_invalid' };
  const minutes = /^\d{1,3}$/.test(input.duration.trim())
    ? Number(input.duration.trim())
    : NaN;
  if (
    !Number.isInteger(minutes) ||
    minutes < DURATION_MIN ||
    minutes > DURATION_MAX
  )
    return { ok: false, error: 'duration_invalid' };
  return {
    ok: true,
    body: { code, label, nominalDurationMinutes: minutes },
  };
}

export function parseConsultationTypes(
  raw: unknown,
): ConsultationTypeRow[] | null {
  const list = (raw as { consultationTypes?: unknown } | null)
    ?.consultationTypes;
  if (!Array.isArray(list)) return null;
  const rows: ConsultationTypeRow[] = [];
  for (const r of list as Record<string, unknown>[]) {
    if (
      typeof r?.id !== 'string' ||
      typeof r.code !== 'string' ||
      typeof r.label !== 'string' ||
      typeof r.nominalDurationMinutes !== 'number' ||
      typeof r.active !== 'boolean'
    )
      return null;
    rows.push({
      id: r.id,
      code: r.code,
      label: r.label,
      nominalDurationMinutes: r.nominalDurationMinutes,
      active: r.active,
    });
  }
  return rows;
}

export function parseClosures(raw: unknown): string[] | null {
  const list = (raw as { closures?: unknown } | null)?.closures;
  if (!Array.isArray(list)) return null;
  if (
    !list.every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
  )
    return null;
  return [...(list as string[])].sort();
}

// A calendar day has no time zone: format it as UTC so the shown date is the stored one.
export function formatClosureDay(day: string, locale: 'ar' | 'fr'): string {
  return new Intl.DateTimeFormat(`${locale}-DZ-u-nu-latn`, {
    dateStyle: 'full',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}
