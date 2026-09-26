import { describe, expect, it } from 'vitest';
import { absoluteInstantSchema } from '@/platform/http/absolute-instant';

describe('shared absolute instant schema', () => {
  it('rejects impossible, ambiguous, coerced and year-zero instants', () => {
    for (const value of [
      '2026-02-29T09:00:00Z',
      '2028-02-30T09:00:00Z',
      '2026-04-31T09:00:00Z',
      '0000-01-01T09:00:00Z',
      '2028-02-29T09:00:00',
      '2028-02-29',
      'not-a-date',
      1780000000000,
      null,
    ]) {
      expect(absoluteInstantSchema.safeParse(value).success).toBe(false);
    }
  });

  it('preserves valid UTC and offset-bearing leap-day instants', () => {
    expect(
      absoluteInstantSchema.parse('2028-02-29T09:00:00.000Z').toISOString(),
    ).toBe('2028-02-29T09:00:00.000Z');
    expect(
      absoluteInstantSchema.parse('2028-02-29T11:00:00+01:00').toISOString(),
    ).toBe('2028-02-29T10:00:00.000Z');
  });
});
