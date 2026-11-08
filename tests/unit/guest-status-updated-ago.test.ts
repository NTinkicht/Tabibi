import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdatedAgoText } from '../../src/app/guest/status/UpdatedAgoText';
import {
  formatUpdatedAgo,
  startUpdatedAgoTicker,
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

describe('UpdatedAgoText', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the localised relative age for each locale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 20_000);
    const html = (locale: 'en' | 'fr' | 'ar') =>
      renderToStaticMarkup(
        createElement(UpdatedAgoText, {
          generatedAt: '2026-11-08T10:00:00.000Z',
          locale,
        }),
      );
    expect(html('en')).toBe('Updated 20 s ago');
    expect(html('fr')).toBe('Mis à jour il y a 20 s');
    expect(html('ar')).toBe('آخر تحديث قبل 20 ثانية');
  });

  it('renders nothing for an unparsable timestamp', () => {
    expect(
      renderToStaticMarkup(
        createElement(UpdatedAgoText, { generatedAt: 'nope', locale: 'en' }),
      ),
    ).toBe('');
  });
});

describe('startUpdatedAgoTicker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks every 5 s with the current time and stops on cleanup', () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const seen: number[] = [];
    const stop = startUpdatedAgoTicker(
      (ms) => seen.push(ms),
      () => clock,
    );
    vi.advanceTimersByTime(4_999);
    expect(seen).toEqual([]);
    clock = 6_000;
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([6_000]);
    clock = 11_000;
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([6_000, 11_000]);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual([6_000, 11_000]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
