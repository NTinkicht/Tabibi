import { describe, expect, it } from 'vitest';
import {
  formatUpdatedAgo,
  updatedAgo,
} from '../../src/app/guest/status/updated-ago';

const T0 = Date.parse('2026-11-08T10:00:00.000Z');

describe('guest status relative age', () => {
  it('reports seconds, minutes and hours', () => {
    expect(updatedAgo('2026-11-08T10:00:00.000Z', T0 + 20_000)).toEqual({
      unit: 'second',
      value: 20,
    });
    expect(updatedAgo('2026-11-08T10:00:00.000Z', T0 + 125_000)).toEqual({
      unit: 'minute',
      value: 2,
    });
    expect(updatedAgo('2026-11-08T10:00:00.000Z', T0 + 3 * 3_600_000)).toEqual({
      unit: 'hour',
      value: 3,
    });
  });

  it('clamps a future stamp (device clock behind) to zero and ignores garbage', () => {
    expect(updatedAgo('2026-11-08T10:00:30.000Z', T0)).toEqual({
      unit: 'second',
      value: 0,
    });
    expect(updatedAgo('not-a-date', T0)).toBeNull();
  });

  it('localises fr, ar and en', () => {
    const age = { unit: 'second', value: 20 } as const;
    expect(formatUpdatedAgo(age, 'fr')).toBe('Mis à jour il y a 20 s');
    expect(formatUpdatedAgo(age, 'ar')).toBe('آخر تحديث قبل 20 ثانية');
    expect(formatUpdatedAgo(age, 'en')).toBe('Updated 20 s ago');
  });
});
