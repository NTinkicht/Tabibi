import { describe, expect, it } from 'vitest';
import {
  activeRanges,
  buildGenerationBody,
  buildTemplateBody,
  canAddRange,
  templateSyncReducer,
  fillTemplate,
  nextOccurrenceIndex,
  parseAbsences,
  parseGenerated,
  parseTemplates,
  periodEnd,
  weekdayName,
  type TemplateRow,
} from '@/app/operations/[clinicId]/settings/schedule-model';
import {
  absenceSchema,
  createTemplateSchema,
  generationSchema,
} from '@/platform/http/scheduling-input';

// TAB-UI-15 (#829) slice 4: the schedule panels only send bodies the server accepts.
const D = '11111111-1111-4111-8111-111111111111';
const row = (over: Partial<TemplateRow>): TemplateRow => ({
  id: 't',
  weekday: 1,
  localStartTime: '09:00',
  localEndTime: '12:00',
  occurrenceIndex: 0,
  active: true,
  ...over,
});

describe('parseTemplates', () => {
  it('trims HH:MM:SS to HH:MM and rejects malformed rows', () => {
    const ok = parseTemplates({
      templates: [
        {
          id: 'a',
          weekday: 2,
          localStartTime: '09:00:00',
          localEndTime: '12:30:00',
          occurrenceIndex: 0,
          active: true,
        },
      ],
    });
    expect(ok?.[0]).toMatchObject({
      localStartTime: '09:00',
      localEndTime: '12:30',
    });
    expect(parseTemplates({})).toBeNull();
    expect(parseTemplates({ templates: [{ id: 'a', weekday: 9 }] })).toBeNull();
  });
});

describe('weekly ranges', () => {
  it('lists active ranges only, earliest first', () => {
    const rows = [
      row({
        id: 'late',
        localStartTime: '14:00',
        localEndTime: '17:00',
        occurrenceIndex: 1,
      }),
      row({ id: 'off', active: false, occurrenceIndex: 2 }),
      row({ id: 'early' }),
      row({ id: 'other', weekday: 3 }),
    ];
    expect(activeRanges(rows, 1).map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('next occurrence index counts deactivated rows so it never collides', () => {
    const rows = [
      row({ occurrenceIndex: 0 }),
      row({ occurrenceIndex: 1, active: false }),
    ];
    expect(nextOccurrenceIndex(rows, 1)).toBe(2);
    expect(nextOccurrenceIndex(rows, 4)).toBe(0);
  });

  it('builds a body the server schema accepts and refuses bad times', () => {
    const built = buildTemplateBody({
      doctorId: D,
      weekday: 1,
      start: '08:30',
      end: '12:00',
      templates: [row({})],
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.body.occurrenceIndex).toBe(1);
      expect(createTemplateSchema.safeParse(built.body).success).toBe(true);
    }
    const bad = { doctorId: D, weekday: 1, templates: [] };
    expect(buildTemplateBody({ ...bad, start: '12:00', end: '12:00' })).toEqual(
      {
        ok: false,
        error: 'end_before_start',
      },
    );
    expect(buildTemplateBody({ ...bad, start: '', end: '12:00' })).toEqual({
      ok: false,
      error: 'time_invalid',
    });
    expect(buildTemplateBody({ ...bad, start: '25:00', end: '26:00' }).ok).toBe(
      false,
    );
  });
});

describe('generation', () => {
  it('maps 4 and 8 weeks to 28 and 56 days and nothing else', () => {
    for (const [weeks, days] of [
      [4, 28],
      [8, 56],
    ] as const) {
      const built = buildGenerationBody({
        doctorId: D,
        startDate: '2026-11-08',
        weeks,
      });
      expect(built.ok && built.body.daysAhead).toBe(days);
      expect(built.ok && generationSchema.safeParse(built.body).success).toBe(
        true,
      );
    }
    expect(
      buildGenerationBody({ doctorId: D, startDate: '2026-11-08', weeks: 5 })
        .ok,
    ).toBe(false);
    expect(
      buildGenerationBody({ doctorId: D, startDate: '', weeks: 4 }).ok,
    ).toBe(false);
  });

  it('reads the count and states the requested period, matching the spec example', () => {
    expect(parseGenerated({ generated: 12 })).toBe(12);
    expect(parseGenerated({ generated: -1 })).toBeNull();
    expect(parseGenerated({})).toBeNull();
    expect(periodEnd('2026-11-08', 4)).toBe('2026-12-05');
    expect(periodEnd('2026-11-08', 8)).toBe('2027-01-02');
    expect(
      fillTemplate('{n} du {from} au {to}', { n: 12, from: 'a', to: 'b' }),
    ).toBe('12 du a au b');
  });
});

describe('absences and weekdays', () => {
  it('parses and sorts absence days; the body shape is the schema', () => {
    expect(parseAbsences({ absences: ['2026-12-02', '2026-11-03'] })).toEqual([
      '2026-11-03',
      '2026-12-02',
    ]);
    expect(parseAbsences({ absences: ['x'] })).toBeNull();
    expect(absenceSchema.safeParse({ absenceDate: '2026-11-03' }).success).toBe(
      true,
    );
  });

  it('starts the week on Sunday in both languages', () => {
    expect(weekdayName(0, 'fr').toLowerCase()).toBe('dimanche');
    expect(weekdayName(1, 'fr').toLowerCase()).toBe('lundi');
    expect(weekdayName(0, 'ar')).not.toBe(weekdayName(1, 'ar'));
  });
});

describe('template snapshot sync gate', () => {
  it('blocks additions from a mutation until the reload has completed', () => {
    let sync = templateSyncReducer('synced', 'refresh');
    expect(canAddRange(sync, false)).toBe(false);
    sync = templateSyncReducer(sync, 'loaded');
    expect(canAddRange(sync, false)).toBe(true);
    expect(canAddRange(sync, true)).toBe(false);
  });

  it('keeps additions blocked after a failed reload until a retry loads', () => {
    let sync = templateSyncReducer('refreshing', 'failed');
    expect(sync).toBe('stale');
    expect(canAddRange(sync, false)).toBe(false);
    sync = templateSyncReducer(sync, 'refresh');
    expect(canAddRange(sync, false)).toBe(false);
    sync = templateSyncReducer(sync, 'loaded');
    expect(canAddRange(sync, false)).toBe(true);
  });
});
