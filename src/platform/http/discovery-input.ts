import { isSpecialtyCode } from '@/modules/clinic/specialties';
import { isWilayaCode } from '@/modules/clinic/wilayas';

// TAB-P0-03 (#688): the only query parameters GET /api/public/discovery
// accepts. Anything else (an unknown or misspelt key, a repeated key, an
// empty value or a code outside the versioned lists) is refused rather than
// ignored, so a malformed filter never silently returns an unfiltered list.
const FILTER_KEYS = new Set(['wilaya', 'specialty']);

export interface DiscoveryFilterInput {
  wilayaCode?: string;
  specialtyCode?: string;
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
  return filters;
}
