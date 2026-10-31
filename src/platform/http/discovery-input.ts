import { PUBLIC_DISCOVERY_MAX_PAGE } from '@/modules/clinic/discovery-page';
import {
  type DiscoveryLanguageCode,
  isDiscoveryLanguageCode,
} from '@/modules/clinic/languages';
import { isSpecialtyCode } from '@/modules/clinic/specialties';
import { isWilayaCode } from '@/modules/clinic/wilayas';

// TAB-P0-03 (#688): the only query parameters GET /api/public/discovery
// accepts. Anything else (an unknown or misspelt key, a repeated key, an
// empty value or a code outside the versioned lists) is refused rather than
// ignored, so a malformed filter never silently returns an unfiltered list.
// TAB-P0-03 (#692): `available` accepts exactly `true`; any other value
// (`false`, `1`, empty) is refused, never read as "no filter".
// TAB-P0-03 (#694): `page` is a canonical decimal 1..PUBLIC_DISCOVERY_MAX_PAGE
// (no sign, leading zero, fraction or exponent); the page size is fixed by
// the server and cannot be chosen by the caller.
// TAB-P0-03 (#696): `language` is exactly `ar` or `fr` (lower case).
const FILTER_KEYS = new Set([
  'wilaya',
  'specialty',
  'available',
  'language',
  'page',
]);
const PAGE_PATTERN = /^[1-9][0-9]{0,2}$/;

export interface DiscoveryFilterInput {
  wilayaCode?: string;
  specialtyCode?: string;
  availableOnly?: true;
  languageCode?: DiscoveryLanguageCode;
  page?: number;
}

export function parseDiscoveryFilters(
  url: string,
): DiscoveryFilterInput | null {
  const params = new URL(url).searchParams;
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!FILTER_KEYS.has(key) || seen.has(key)) return null;
    seen.add(key);
  }
  const filters: DiscoveryFilterInput = {};
  const wilaya = params.get('wilaya');
  if (wilaya !== null) {
    if (!isWilayaCode(wilaya)) return null;
    filters.wilayaCode = wilaya;
  }
  const specialty = params.get('specialty');
  if (specialty !== null) {
    if (!isSpecialtyCode(specialty)) return null;
    filters.specialtyCode = specialty;
  }
  const available = params.get('available');
  if (available !== null) {
    if (available !== 'true') return null;
    filters.availableOnly = true;
  }
  const language = params.get('language');
  if (language !== null) {
    if (!isDiscoveryLanguageCode(language)) return null;
    filters.languageCode = language;
  }
  const page = params.get('page');
  if (page !== null) {
    if (!PAGE_PATTERN.test(page)) return null;
    const value = Number(page);
    if (value > PUBLIC_DISCOVERY_MAX_PAGE) return null;
    filters.page = value;
  }
  return filters;
}
