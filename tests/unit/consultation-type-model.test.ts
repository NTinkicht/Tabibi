import { describe, expect, it } from 'vitest';
import {
  buildNewTypeBody,
  formatClosureDay,
  parseClosures,
  parseConsultationTypes,
  suggestCode,
} from '@/app/operations/[clinicId]/settings/consultation-type-model';
import { createConsultationTypeSchema } from '@/platform/http/scheduling-input';

// TAB-UI-15 (#829): the consultation-type form only sends bodies the server accepts.
describe('suggestCode', () => {
  it('folds accents and separators', () => {
    expect(suggestCode('Première consultation')).toBe('premiere-consultation');
    expect(suggestCode('  Suivi / contrôle  ')).toBe('suivi-controle');
  });
  it('is empty for an Arabic-only label and capped at 48 characters', () => {
    expect(suggestCode('استشارة')).toBe('');
    expect(suggestCode('a'.repeat(60))).toHaveLength(48);
    expect(suggestCode(`${'a'.repeat(47)} b`)).toBe('a'.repeat(47));
  });
});

describe('buildNewTypeBody', () => {
  const ok = { label: ' Contrôle ', code: 'controle', duration: '20' };
  it('trims and produces a body the server schema accepts', () => {
    const r = buildNewTypeBody(ok);
    expect(r).toEqual({
      ok: true,
      body: { code: 'controle', label: 'Contrôle', nominalDurationMinutes: 20 },
    });
    if (r.ok)
      expect(createConsultationTypeSchema.safeParse(r.body).success).toBe(true);
  });
  it('refuses blank labels, bad codes and out-of-range durations', () => {
    expect(buildNewTypeBody({ ...ok, label: '  ' })).toEqual({
      ok: false,
      error: 'label_required',
    });
    expect(buildNewTypeBody({ ...ok, code: 'Bad Code' })).toEqual({
      ok: false,
      error: 'code_invalid',
    });
    expect(buildNewTypeBody({ ...ok, code: '' })).toEqual({
      ok: false,
      error: 'code_invalid',
    });
    for (const duration of ['4', '241', '', '1.5', 'abc'])
      expect(buildNewTypeBody({ ...ok, duration })).toEqual({
        ok: false,
        error: 'duration_invalid',
      });
  });
  it('accepts the duration bounds', () => {
    expect(buildNewTypeBody({ ...ok, duration: '5' }).ok).toBe(true);
    expect(buildNewTypeBody({ ...ok, duration: '240' }).ok).toBe(true);
  });
});

describe('response parsers', () => {
  it('parses closures sorted and rejects malformed lists', () => {
    expect(parseClosures({ closures: ['2026-12-02', '2026-11-30'] })).toEqual([
      '2026-11-30',
      '2026-12-02',
    ]);
    expect(parseClosures({ closures: ['soon'] })).toBeNull();
    expect(parseClosures({})).toBeNull();
  });
  it('parses consultation types and rejects malformed rows', () => {
    const row = {
      id: 'i',
      code: 'c',
      label: 'L',
      nominalDurationMinutes: 10,
      active: true,
      clinicId: 'x',
    };
    expect(parseConsultationTypes({ consultationTypes: [row] })).toEqual([
      {
        id: 'i',
        code: 'c',
        label: 'L',
        nominalDurationMinutes: 10,
        active: true,
      },
    ]);
    expect(
      parseConsultationTypes({
        consultationTypes: [{ ...row, active: 'yes' }],
      }),
    ).toBeNull();
    expect(parseConsultationTypes(null)).toBeNull();
  });
});

describe('formatClosureDay', () => {
  it('shows the stored calendar day with Western digits in both languages', () => {
    expect(formatClosureDay('2026-12-05', 'fr')).toContain('5');
    expect(formatClosureDay('2026-12-05', 'fr')).toContain('2026');
    expect(formatClosureDay('2026-12-05', 'ar')).toMatch(/2026/);
    expect(formatClosureDay('2026-12-05', 'ar')).toMatch(/\b5\b/);
  });
});
