import { describe, expect, it } from 'vitest';
import {
  isWilayaCode,
  WILAYA_LIST_VERSION,
  WILAYAS,
} from '@/modules/clinic/wilayas';

// TAB-P0-02 (#686): the versioned wilaya list must stay exactly aligned with
// the clinics.wilaya_code CHECK in 0040_clinic_location.sql (codes 01..58).
describe('versioned wilaya list', () => {
  it('names its version', () => {
    expect(WILAYA_LIST_VERSION).toBe('dz-wilayas-2019-58');
  });

  it('holds the 58 two-digit codes 01..58 in order, once each', () => {
    const expected = Array.from({ length: 58 }, (_, i) =>
      String(i + 1).padStart(2, '0'),
    );
    expect(WILAYAS.map((w) => w.code)).toEqual(expected);
  });

  it('gives every wilaya a non-blank, unique Arabic and French label', () => {
    for (const locale of ['ar', 'fr'] as const) {
      const labels = WILAYAS.map((w) => w.labels[locale]);
      for (const label of labels) {
        expect(label.trim()).toBe(label);
        expect(label.length).toBeGreaterThan(0);
      }
      expect(new Set(labels).size).toBe(58);
    }
    expect(WILAYAS.find((w) => w.code === '16')?.labels).toEqual({
      ar: 'الجزائر',
      fr: 'Alger',
    });
    for (const wilaya of WILAYAS) {
      expect(wilaya.labels.ar).toMatch(/^[؀-ۿ ]+$/);
    }
  });

  it.each(['01', '16', '48', '58'])('accepts %s', (code) => {
    expect(isWilayaCode(code)).toBe(true);
  });

  it.each(['00', '59', '1', '016', ' 16', 'Alger', ''])(
    'rejects %j',
    (code) => {
      expect(isWilayaCode(code)).toBe(false);
    },
  );

  it('cannot be mutated at runtime', () => {
    expect(Object.isFrozen(WILAYAS)).toBe(true);
    expect(Object.isFrozen(WILAYAS[0])).toBe(true);
  });
});
