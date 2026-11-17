import { describe, expect, it } from 'vitest';
import {
  defaultWindow,
  isValidWindow,
  toStatisticsView,
} from '@/app/operations/[clinicId]/statistics/statistics-model';

const doctor = {
  doctorId: 'd1',
  doctorName: 'Dr Amine',
  sessions: 3,
  completed: 10,
  noShow: 1,
  cancelled: 0,
  averageConsultationSeconds: null,
  openedSessions: 3,
  lateStarts: 1,
  averageStartDelayMinutes: 4.5,
  extraPrivateField: 'must-not-survive',
};
const payload = {
  from: '2026-11-01',
  to: '2026-11-07',
  totals: {
    sessions: 3,
    completed: 10,
    noShow: 1,
    cancelled: 0,
    openedSessions: 3,
    lateStarts: 1,
  },
  doctors: [doctor],
  delayTrend: [{ date: '2026-11-01', sessions: 3, opened: 3, lateStarts: 1 }],
};

describe('statistics model', () => {
  it('parses a valid payload, keeping withheld averages null and dropping unknown fields', () => {
    const view = toStatisticsView(payload);
    expect(view.doctors[0].averageConsultationSeconds).toBeNull();
    expect(view.doctors[0].averageStartDelayMinutes).toBe(4.5);
    expect(view.totals.noShow).toBe(1);
    expect(JSON.stringify(view)).not.toContain('must-not-survive');
  });

  it.each([
    ['null body', null],
    ['missing totals', { ...payload, totals: undefined }],
    [
      'negative count',
      { ...payload, totals: { ...payload.totals, sessions: -1 } },
    ],
    [
      'fractional count',
      { ...payload, doctors: [{ ...doctor, sessions: 1.5 }] },
    ],
    [
      'string average',
      { ...payload, doctors: [{ ...doctor, averageStartDelayMinutes: '4' }] },
    ],
    ['trend not array', { ...payload, delayTrend: {} }],
  ])('rejects %s', (_name, body) => {
    expect(() => toStatisticsView(body)).toThrow('Invalid response');
  });

  it('validates the window: ordered, real dates, at most 31 days', () => {
    expect(isValidWindow('2026-11-01', '2026-11-07')).toBe(true);
    expect(isValidWindow('2026-11-01', '2026-12-01')).toBe(true);
    expect(isValidWindow('2026-11-01', '2026-12-02')).toBe(false);
    expect(isValidWindow('2026-11-07', '2026-11-01')).toBe(false);
    expect(isValidWindow('2026-02-30', '2026-03-02')).toBe(false);
    expect(isValidWindow('', '2026-03-02')).toBe(false);
  });

  it('defaults to the seven local days ending today', () => {
    const window = defaultWindow(new Date(2026, 2, 3));
    expect(window).toEqual({ from: '2026-02-25', to: '2026-03-03' });
    expect(isValidWindow(window.from, window.to)).toBe(true);
  });
});
