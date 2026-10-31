import { describe, expect, it, vi } from 'vitest';
import { fetchAllDiscoveryPages } from '@/app/public-discovery-pages';

// TAB-P0-03 (#694): the landing client follows every discovery page so a
// refresh never drops clinics beyond the first page, and fails closed on a
// malformed page.
const parse = (value: unknown) => {
  const clinics = (value as { clinics?: unknown }).clinics;
  return Array.isArray(clinics) && clinics.every((c) => typeof c === 'string')
    ? (clinics as string[])
    : null;
};

function fakeFetch(bodies: Array<unknown | { status: number }>) {
  const urls: string[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    expect(init).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const body = bodies.shift();
    if (body && typeof body === 'object' && 'status' in body) {
      return new Response('unavailable', { status: body.status as number });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, urls };
}

const signal = new AbortController().signal;

describe('fetchAllDiscoveryPages', () => {
  it('returns a single page without requesting more', async () => {
    const { impl, urls } = fakeFetch([
      { clinics: ['A', 'B'], page: 1, hasMore: false },
    ]);
    await expect(fetchAllDiscoveryPages(impl, signal, parse)).resolves.toEqual([
      'A',
      'B',
    ]);
    expect(urls).toEqual(['/api/public/discovery']);
  });

  it('follows hasMore page by page and concatenates in order', async () => {
    const { impl, urls } = fakeFetch([
      { clinics: ['A'], page: 1, hasMore: true },
      { clinics: ['B'], page: 2, hasMore: true },
      { clinics: ['C'], page: 3, hasMore: false },
    ]);
    await expect(fetchAllDiscoveryPages(impl, signal, parse)).resolves.toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(urls).toEqual([
      '/api/public/discovery',
      '/api/public/discovery?page=2',
      '/api/public/discovery?page=3',
    ]);
  });

  it('fails closed on a malformed or unavailable page', async () => {
    for (const second of [
      { clinics: ['B'], page: 3, hasMore: false },
      { clinics: ['B'], page: 2, hasMore: 'false' },
      { clinics: ['B'], page: 2 },
      { clinics: ['B'], hasMore: false },
      { clinics: [7], page: 2, hasMore: false },
      null,
      { status: 503 },
    ]) {
      const { impl } = fakeFetch([
        { clinics: ['A'], page: 1, hasMore: true },
        second,
      ]);
      await expect(
        fetchAllDiscoveryPages(impl, signal, parse),
      ).rejects.toThrow();
    }
  });

  it('refuses a first page without paging fields', async () => {
    const { impl } = fakeFetch([{ clinics: ['A'] }]);
    await expect(fetchAllDiscoveryPages(impl, signal, parse)).rejects.toThrow(
      'Invalid discovery page',
    );
  });

  it('stops at the server page bound instead of looping forever', async () => {
    const bodies = Array.from({ length: 501 }, (_, i) => ({
      clinics: [`C${i + 1}`],
      page: i + 1,
      hasMore: true,
    }));
    const { impl, urls } = fakeFetch(bodies);
    await expect(fetchAllDiscoveryPages(impl, signal, parse)).rejects.toThrow(
      'Discovery page bound exceeded',
    );
    expect(urls).toHaveLength(500);
  });
});
