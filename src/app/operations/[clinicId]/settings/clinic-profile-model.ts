// TAB-UI-15 (#829): pure view-model for the clinic profile form
// (docs/design/clinic-setup.md, "Clinique tab > Profil"). It builds the
// PATCH /api/clinics/{clinicId} body from the form and refuses anything the
// server schema (updateClinicSchema) would refuse, so the UI never sends a
// partial location or an inconsistent locale pair.

export type ClinicLocale = 'ar' | 'fr';

export type ClinicProfile = {
  name: string;
  timezone: string;
  defaultLocale: ClinicLocale;
  enabledLocales: ClinicLocale[];
  wilayaCode: string | null;
  commune: string | null;
  addressLine: string | null;
};

export type ProfileForm = {
  name: string;
  timezone: string;
  defaultLocale: ClinicLocale;
  enabledLocales: ClinicLocale[];
  wilayaCode: string;
  commune: string;
  addressLine: string;
};

export type ProfileError =
  | 'name_required'
  | 'timezone_required'
  | 'locale_required'
  | 'default_locale_not_offered'
  | 'unchanged';

export type ProfilePatchResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: ProfileError };

export function formFromProfile(profile: ClinicProfile): ProfileForm {
  return {
    name: profile.name,
    timezone: profile.timezone,
    defaultLocale: profile.defaultLocale,
    enabledLocales: [...profile.enabledLocales],
    wilayaCode: profile.wilayaCode ?? '',
    commune: profile.commune ?? '',
    addressLine: profile.addressLine ?? '',
  };
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// Only changed groups are sent. The location travels whole (wilaya, commune,
// address) and the locale pair travels whole, exactly as the API requires.
export function buildProfilePatch(
  initial: ClinicProfile,
  form: ProfileForm,
): ProfilePatchResult {
  const name = form.name.trim();
  if (name === '') return { ok: false, error: 'name_required' };
  if (form.timezone.trim() === '')
    return { ok: false, error: 'timezone_required' };
  if (form.enabledLocales.length === 0)
    return { ok: false, error: 'locale_required' };
  if (!form.enabledLocales.includes(form.defaultLocale))
    return { ok: false, error: 'default_locale_not_offered' };

  const body: Record<string, unknown> = {};
  if (name !== initial.name) body.name = name;
  if (form.timezone !== initial.timezone) body.timezone = form.timezone;

  const wilayaCode = form.wilayaCode === '' ? null : form.wilayaCode;
  // Without a wilaya the server rejects a commune or address.
  const commune = wilayaCode === null ? null : textOrNull(form.commune);
  const addressLine = wilayaCode === null ? null : textOrNull(form.addressLine);
  if (
    wilayaCode !== initial.wilayaCode ||
    commune !== initial.commune ||
    addressLine !== initial.addressLine
  ) {
    body.wilayaCode = wilayaCode;
    body.commune = commune;
    body.addressLine = addressLine;
  }

  const enabled = (['ar', 'fr'] as const).filter((l) =>
    form.enabledLocales.includes(l),
  );
  const initialEnabled = (['ar', 'fr'] as const).filter((l) =>
    initial.enabledLocales.includes(l),
  );
  if (
    form.defaultLocale !== initial.defaultLocale ||
    enabled.join() !== initialEnabled.join()
  ) {
    body.defaultLocale = form.defaultLocale;
    body.enabledLocales = enabled;
  }

  if (Object.keys(body).length === 0) return { ok: false, error: 'unchanged' };
  return { ok: true, body };
}

// A stable list of supported zones that always keeps the stored value, so the
// options never depend on the current selection.
const COMMON_TIMEZONES = [
  'Africa/Algiers',
  'Africa/Tunis',
  'Africa/Tripoli',
  'Africa/Casablanca',
  'Africa/Cairo',
  'Europe/Paris',
  'UTC',
] as const;

export function timezoneOptions(stored: string): string[] {
  return COMMON_TIMEZONES.includes(stored as (typeof COMMON_TIMEZONES)[number])
    ? [...COMMON_TIMEZONES]
    : [stored, ...COMMON_TIMEZONES];
}
