import { isSpecialtyCode } from '@/modules/clinic/specialties';
import { isWilayaCode } from '@/modules/clinic/wilayas';

// TAB-P0-03 (#688): the only query parameters GET /api/public/discovery
// accepts. Anything else (an unknown or misspelt key, a repeated key, an
// empty value or a code outside the versioned lists) is refused rather than
// ignored, so a malformed filter never silently returns an unfiltered list.
// TAB-P0-03 (#692): `available` accepts exactly `true`; any other value
// (`false`, `1`, empty) is refused, never read as "no filter".
const FILTER_KEYS = new Set(['wilaya', 'specialty', 'available']);

export interface DiscoveryFilterInput {
  wilayaCode?: string;
  specialtyCode?: string;
  availableOnly?: true;
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
  return filters;
}
