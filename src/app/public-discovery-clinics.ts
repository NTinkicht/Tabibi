import { SPECIALTIES, isSpecialtyCode } from '@/modules/clinic/specialties';
import { WILAYAS, isWilayaCode } from '@/modules/clinic/wilayas';

// TAB-P0-03 (#698): the exact public clinic shape the landing page renders.
// Location and doctor specialties are already published by
// GET /api/public/discovery; only these fields cross into the client and
// codes are always rendered through the versioned label lists, never raw.
export type PublicLocale = 'ar' | 'fr';

export type PublicClinicDoctor = {
  displayName: string;
  specialtyCodes: string[];
};

export type PublicClinic = {
  name: string;
  defaultLocale: PublicLocale;
  enabledLocales: PublicLocale[];
  wilayaCode: string | null;
  commune: string | null;
  addressLine: string | null;
  doctors: PublicClinicDoctor[];
};

const WILAYA_LABELS = new Map(WILAYAS.map((w) => [w.code, w.labels]));
const SPECIALTY_LABELS = new Map(SPECIALTIES.map((s) => [s.code, s.labels]));

export function wilayaName(code: string, locale: PublicLocale): string | null {
  return WILAYA_LABELS.get(code)?.[locale] ?? null;
}

export function specialtyName(
  code: string,
  locale: PublicLocale,
): string | null {
  return SPECIALTY_LABELS.get(code)?.[locale] ?? null;
}

// Absent and null both mean "not published"; any other non-string value is
// malformed.
function optionalText(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in record) || record[key] === null) return null;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Parse one discovery page body into the public clinic allow-list. Any
 * malformed clinic, unknown wilaya or specialty code, or a commune/address
 * without a wilaya rejects the whole page (null) so the caller fails closed.
 */
export function parsePublicClinics(value: unknown): PublicClinic[] | null {
  if (typeof value !== 'object' || value === null || !('clinics' in value)) {
    return null;
  }
  const clinics = value.clinics;
  if (!Array.isArray(clinics)) return null;
  const result: PublicClinic[] = [];
  for (const clinic of clinics as unknown[]) {
    if (typeof clinic !== 'object' || clinic === null) return null;
    const record = clinic as Record<string, unknown>;
    const { name, defaultLocale, enabledLocales, doctors } = record;
    if (
      typeof name !== 'string' ||
      (defaultLocale !== 'ar' && defaultLocale !== 'fr') ||
      !Array.isArray(enabledLocales) ||
      !enabledLocales.every((entry) => entry === 'ar' || entry === 'fr') ||
      !Array.isArray(doctors)
    ) {
      return null;
    }
    const wilayaCode = optionalText(record, 'wilayaCode');
    const commune = optionalText(record, 'commune');
    const addressLine = optionalText(record, 'addressLine');
    if (
      wilayaCode === undefined ||
      commune === undefined ||
      addressLine === undefined ||
      (wilayaCode !== null && !isWilayaCode(wilayaCode)) ||
      (wilayaCode === null && (commune !== null || addressLine !== null))
    ) {
      return null;
    }
    const parsedDoctors: PublicClinicDoctor[] = [];
    for (const doctor of doctors as unknown[]) {
      if (typeof doctor !== 'object' || doctor === null) return null;
      const doctorRecord = doctor as Record<string, unknown>;
      if (typeof doctorRecord.displayName !== 'string') return null;
      const codes =
        'specialtyCodes' in doctorRecord ? doctorRecord.specialtyCodes : [];
      if (!Array.isArray(codes) || !codes.every(isSpecialtyCode)) return null;
      parsedDoctors.push({
        displayName: doctorRecord.displayName,
        specialtyCodes: [...codes],
      });
    }
    result.push({
      name,
      defaultLocale,
      enabledLocales: [...(enabledLocales as PublicLocale[])],
      wilayaCode,
      commune,
      addressLine,
      doctors: parsedDoctors,
    });
  }
  return result;
}

// Street address, commune and localized wilaya name, most specific first.
// Codes outside the versioned lists are never rendered.
export function clinicLocation(
  clinic: PublicClinic,
  locale: PublicLocale,
): string | null {
  if (clinic.wilayaCode === null) return null;
  const wilaya = wilayaName(clinic.wilayaCode, locale);
  if (wilaya === null) return null;
  return [clinic.addressLine, clinic.commune, wilaya]
    .filter((part) => part !== null)
    .join(locale === 'ar' ? '، ' : ', ');
}

// Localized specialty labels in the published order, or null when none.
export function doctorSpecialties(
  doctor: PublicClinicDoctor,
  locale: PublicLocale,
): string | null {
  const labels = doctor.specialtyCodes
    .map((code) => specialtyName(code, locale))
    .filter((label) => label !== null);
  return labels.length > 0 ? labels.join(locale === 'ar' ? '، ' : ', ') : null;
}
