import { PUBLIC_DISCOVERY_MAX_PAGE } from '@/modules/clinic/discovery-page';

// TAB-P0-03 (#694): GET /api/public/discovery is paged. A client that needs
// the whole public directory follows `hasMore` page by page, in order, and
// fails closed on any malformed page (wrong page number, non-boolean
// hasMore, invalid clinics) or when the server-side page bound is reached
// with more still announced, so a refresh never silently drops clinics.
export async function fetchAllDiscoveryPages<T>(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  parseClinics: (value: unknown) => T[] | null,
): Promise<T[]> {
  const clinics: T[] = [];
  for (let page = 1; page <= PUBLIC_DISCOVERY_MAX_PAGE; page += 1) {
    // Page 1 is the parameterless default the server also answers with
    // `page: 1`; later pages are requested explicitly.
    const url =
      page === 1
        ? '/api/public/discovery'
        : `/api/public/discovery?page=${page}`;
    const response = await fetchImpl(url, {
      signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Discovery unavailable');
    const result: unknown = await response.json();
    if (
      typeof result !== 'object' ||
      result === null ||
      !('page' in result) ||
      !('hasMore' in result) ||
      result.page !== page ||
      typeof result.hasMore !== 'boolean'
    ) {
      throw new Error('Invalid discovery page');
    }
    const pageClinics = parseClinics(result);
    if (pageClinics === null) throw new Error('Invalid discovery shape');
    clinics.push(...pageClinics);
    if (!result.hasMore) return clinics;
  }
  throw new Error('Discovery page bound exceeded');
}
