import { describe, expect, it } from 'vitest';
import { parseDiscoveryFilters } from '@/platform/http/discovery-input';

// TAB-P0-03 (#694): the discovery query parser refuses (null) every repeated
// key, including every repeated or mixed `page` form, rather than reading the
// first value.
const parse = (query: string) =>
  parseDiscoveryFilters(`https://tabibi.test/api/public/discovery${query}`);

describe('parseDiscoveryFilters page parameter', () => {
  it('accepts one canonical page within bounds', () => {
    expect(parse('?page=1')).toEqual({ page: 1 });
    expect(parse('?page=500&wilaya=16')).toEqual({
      page: 500,
      wilayaCode: '16',
    });
  });

  it('refuses repeated page keys whatever their values or order', () => {
    for (const query of [
      '?page=1&page=2',
      '?page=2&page=1',
      '?page=1&page=1',
      '?page=1&wilaya=16&page=1',
      '?page=&page=1',
      '?page=1&page',
    ]) {
      expect(parse(query), query).toBeNull();
    }
  });

  it('refuses malformed or out-of-range pages', () => {
    for (const query of ['?page=0', '?page=01', '?page=501', '?page=1.0']) {
      expect(parse(query), query).toBeNull();
    }
  });
});

describe('parseDiscoveryFilters language parameter (#696)', () => {
  it('accepts exactly ar or fr and composes with the other filters', () => {
    expect(parse('?language=ar')).toEqual({ languageCode: 'ar' });
    expect(parse('?language=fr')).toEqual({ languageCode: 'fr' });
    expect(parse('?page=2&language=fr&wilaya=16')).toEqual({
      page: 2,
      wilayaCode: '16',
      languageCode: 'fr',
    });
  });

  it('refuses unknown, mis-cased, empty, combined or repeated languages', () => {
    for (const query of [
      '?language=en',
      '?language=AR',
      '?language=Fr',
      '?language=',
      '?language',
      '?language=ar,fr',
      '?language=ar%20',
      '?language=fr&language=ar',
      '?language=ar&language=ar',
    ]) {
      expect(parse(query), query).toBeNull();
    }
  });
});
