import { isSpecialtyCode } from '@/modules/clinic/specialties';
import { isWilayaCode } from '@/modules/clinic/wilayas';
import {
  type PublicClinic,
  type PublicLocale,
  parsePublicClinics,
} from '../public-discovery-clinics';

// TAB-P0-03 (#804, docs/design/find-and-book.md): view model for the public
// find-a-doctor page. Only the public allow-lists of GET
// /api/public/bookable-sessions and /api/public/discovery are accepted.
export type FindMode = 'book' | 'directory';
export type FindLanguage = 'all' | PublicLocale;
export type FindFilters = {
  specialty: string;
  wilaya: string;
  language: FindLanguage;
};
export type BookableSession = {
  serviceDate: string;
  startsAt: string;
  endsAt: string;
  selectionReference: string;
};
export type BookableDoctor = {
  displayName: string;
  specialtyCodes: string[];
  sessions: BookableSession[];
};
export type BookableClinic = Omit<PublicClinic, 'doctors'> & {
  doctors: BookableDoctor[];
};

export const EMPTY_FILTERS: FindFilters = {
  specialty: '',
  wilaya: '',
  language: 'all',
};

// Server-sealed references are opaque URL-safe tokens; reject anything else
// before it can reach a navigation target.
const SELECTION_REFERENCE = /^[A-Za-z0-9._~-]{8,2048}$/;
const SERVICE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Strict ISO-8601 instant with an explicit offset (what the API emits);
// Date.parse alone also accepts locale-style strings.
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_INSTANT.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Parse one bookable-sessions page; null (fail closed) on any malformed part. */
export function parseBookableClinics(value: unknown): BookableClinic[] | null {
  if (typeof value !== 'object' || value === null || !('clinics' in value)) {
    return null;
  }
  const rawClinics = value.clinics;
  if (!Array.isArray(rawClinics)) return null;
  // Reuse the discovery location/locale validation on the shared fields.
  const base = parsePublicClinics({
    clinics: rawClinics.map((clinic: unknown) =>
      typeof clinic === 'object' && clinic !== null
        ? { ...clinic, doctors: [] }
        : clinic,
    ),
  });
  if (base === null) return null;
  const result: BookableClinic[] = [];
  for (const [index, clinic] of base.entries()) {
    const rawDoctors = (rawClinics[index] as { doctors?: unknown }).doctors;
    if (!Array.isArray(rawDoctors)) return null;
    const doctors: BookableDoctor[] = [];
    for (const doctor of rawDoctors as unknown[]) {
      if (typeof doctor !== 'object' || doctor === null) return null;
      const { displayName, specialtyCodes, sessions } = doctor as Record<
        string,
        unknown
      >;
      if (
        typeof displayName !== 'string' ||
        !Array.isArray(specialtyCodes) ||
        !specialtyCodes.every(isSpecialtyCode) ||
        !Array.isArray(sessions)
      ) {
        return null;
      }
      const parsedSessions: BookableSession[] = [];
      for (const session of sessions as unknown[]) {
        if (typeof session !== 'object' || session === null) return null;
        const s = session as Record<string, unknown>;
        if (
          typeof s.serviceDate !== 'string' ||
          !SERVICE_DATE.test(s.serviceDate) ||
          !isInstant(s.startsAt) ||
          !isInstant(s.endsAt) ||
          typeof s.selectionReference !== 'string' ||
          !SELECTION_REFERENCE.test(s.selectionReference)
        ) {
          return null;
        }
        parsedSessions.push({
          serviceDate: s.serviceDate,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          selectionReference: s.selectionReference,
        });
      }
      // Booking mode never shows a doctor without a bookable session.
      if (parsedSessions.length > 0) {
        doctors.push({
          displayName,
          specialtyCodes: [...specialtyCodes],
          sessions: parsedSessions,
        });
      }
    }
    if (doctors.length > 0) result.push({ ...clinic, doctors });
  }
  return result;
}

/** Query string for the shared discovery filters (empty when none apply). */
export function filtersQuery(filters: FindFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.wilaya && isWilayaCode(filters.wilaya)) {
    params.set('wilaya', filters.wilaya);
  }
  if (filters.specialty && isSpecialtyCode(filters.specialty)) {
    params.set('specialty', filters.specialty);
  }
  if (filters.language !== 'all') params.set('language', filters.language);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function findEndpoint(
  mode: FindMode,
  filters: FindFilters,
  page: number,
): string {
  const base =
    mode === 'book' ? '/api/public/bookable-sessions' : '/api/public/discovery';
  return `${base}${filtersQuery(filters, page)}`;
}

export function earliestSession(
  doctor: BookableDoctor,
): BookableSession | undefined {
  return [...doctor.sessions].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  )[0];
}

export function bookingPath(session: BookableSession): string {
  return `/guest/live-queue/${encodeURIComponent(session.selectionReference)}`;
}

// Clinics publish no timezone; Algeria observes a single fixed offset.
const CLINIC_TIME_ZONE = 'Africa/Algiers';

export function sessionDayLabel(
  session: BookableSession,
  locale: PublicLocale,
): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-DZ' : 'fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: CLINIC_TIME_ZONE,
  }).format(new Date(session.startsAt));
}

export function sessionHoursLabel(
  session: BookableSession,
  locale: PublicLocale,
): string {
  const format = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-DZ' : 'fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: CLINIC_TIME_ZONE,
  });
  return `${format.format(new Date(session.startsAt))} – ${format.format(new Date(session.endsAt))}`;
}
