import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isSpecialtyCode,
  MAX_SPECIALTIES_PER_ASSOCIATION,
  SPECIALTIES,
  SPECIALTY_LIST_VERSION,
} from '@/modules/clinic/specialties';

// TAB-P0-03 (#687): the controlled specialty list is versioned, frozen and
// identical to the codes the database CHECK accepts.
describe('controlled specialty list', () => {
  it('is versioned with unique snake_case codes and non-blank ar/fr labels', () => {
    expect(SPECIALTY_LIST_VERSION).toBe('tabibi-specialties-v1');
    expect(MAX_SPECIALTIES_PER_ASSOCIATION).toBe(3);
    const codes = SPECIALTIES.map((s) => s.code);
    expect(codes).toHaveLength(20);
    expect(new Set(codes).size).toBe(codes.length);
    for (const specialty of SPECIALTIES) {
      expect(specialty.code).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(Object.keys(specialty.labels).sort()).toEqual(['ar', 'fr']);
      expect(specialty.labels.ar.trim()).not.toBe('');
      expect(specialty.labels.fr.trim()).not.toBe('');
    }
    expect(new Set(SPECIALTIES.map((s) => s.labels.ar)).size).toBe(20);
    expect(new Set(SPECIALTIES.map((s) => s.labels.fr)).size).toBe(20);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SPECIALTIES)).toBe(true);
    for (const specialty of SPECIALTIES) {
      expect(Object.isFrozen(specialty)).toBe(true);
      expect(Object.isFrozen(specialty.labels)).toBe(true);
    }
  });

  it('recognizes exactly the listed codes', () => {
    for (const { code } of SPECIALTIES)
      expect(isSpecialtyCode(code)).toBe(true);
    for (const value of ['', 'Pediatrics', ' ent', 'astrology', null, 1, {}]) {
      expect(isSpecialtyCode(value)).toBe(false);
    }
  });

  it('matches the codes accepted by the 0041 database CHECK', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'db',
        'migrations',
        '0041_clinic_doctor_specialties.sql',
      ),
      'utf8',
    );
    const list = sql.slice(sql.indexOf('ARRAY['), sql.indexOf(']::text[]'));
    const dbCodes = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(dbCodes).toEqual(SPECIALTIES.map((s) => s.code));
  });
});
