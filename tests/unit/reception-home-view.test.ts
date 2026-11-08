import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SessionCard,
  type HomeSession,
} from '@/app/operations/[clinicId]/session-card';
import { receptionistCopy } from '@/modules/localization/receptionist';
import {
  countsLine,
  shiftDate,
  statusTone,
} from '@/modules/receptionist-dashboard/home-view';

const zero = {
  waiting: 0,
  checkedIn: 0,
  called: 0,
  inConsultation: 0,
  completed: 0,
  noShow: 0,
  cancelled: 0,
};

function render(over: Partial<HomeSession>, locale: 'fr' | 'ar' = 'fr') {
  const session: HomeSession = {
    id: 's1',
    doctorId: 'd1',
    doctorDisplayName: 'Dr Leila',
    startsAt: '2026-09-08T08:00:00.000Z',
    endsAt: '2026-09-08T11:00:00.000Z',
    status: 'open',
    openedAt: null,
    closedAt: null,
    declaredDelayMinutes: null,
    delayVersion: 0,
    queueCounts: zero,
    ...over,
  };
  const noop = () => undefined;
  return renderToStaticMarkup(
    createElement(SessionCard, {
      session,
      clinicId: 'c1',
      t: receptionistCopy[locale],
      locale,
      timezone: 'Africa/Algiers',
      pending: false,
      delayValue: '',
      onCommand: noop,
      onDelayChange: noop,
      onDelaySubmit: noop,
      onClearDelay: noop,
    }),
  );
}

describe('reception home view helpers', () => {
  it('builds the counts line from non-zero aggregates only', () => {
    const t = receptionistCopy.fr;
    expect(
      countsLine(
        { ...zero, checkedIn: 4, waiting: 2, called: 1, completed: 6 },
        t,
      ),
    ).toBe('4 arrivés · 2 pas encore · 1 appelé · 6 terminés');
    expect(countsLine(zero, t)).toBe(t.homeCountsNone);
    expect(countsLine(undefined, t)).toBe(t.homeCountsNone);
    expect(countsLine({ ...zero, checkedIn: 1 }, receptionistCopy.ar)).toBe(
      '1 حاضر',
    );
  });

  it('maps every session status to its tone', () => {
    expect(statusTone('planned')).toBe('arrived');
    expect(statusTone('open')).toBe('called');
    expect(statusTone('paused')).toBe('warning');
    expect(statusTone('closed')).toBe('neutral');
    expect(statusTone('cancelled')).toBe('danger');
  });

  it('shifts calendar dates across month and year boundaries', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDate('not-a-date', 1)).toBe('not-a-date');
  });
});

describe('SessionCard actions per status', () => {
  const t = receptionistCopy.fr;
  it('open: console link, pause, close, cancel, counts and chip', () => {
    const html = render({
      status: 'open',
      queueCounts: { ...zero, checkedIn: 4, waiting: 2 },
    });
    expect(html).toContain(t.homeOpenConsole);
    expect(html).toContain('/operations/c1/sessions/s1/queue?locale=fr');
    expect(html).toContain(t.pause);
    expect(html).toContain(t.close);
    expect(html).toContain(t.cancel);
    expect(html).not.toContain(t.homeOpenSession);
    expect(html).toContain('4 arrivés · 2 pas encore');
    expect(html).toContain('tb-chip--called');
  });
  it('paused: resume instead of pause, warning chip', () => {
    const html = render({ status: 'paused' });
    expect(html).toContain(t.resume);
    expect(html).not.toContain(`>${t.pause}<`);
    expect(html).toContain('tb-chip--warning');
    expect(html).toContain(t.homeOpenConsole);
  });
  it('planned: open session and cancel, no console link', () => {
    const html = render({ status: 'planned' });
    expect(html).toContain(t.homeOpenSession);
    expect(html).toContain(t.cancel);
    expect(html).not.toContain(t.homeOpenConsole);
    expect(html).not.toContain(`>${t.close}<`);
    expect(html).toContain('tb-chip--arrived');
  });
  it.each(['closed', 'cancelled'] as const)(
    '%s: summary link only, no commands or delay form',
    (status) => {
      const html = render({ status });
      expect(html).toContain(t.homeViewSummary);
      expect(html).not.toContain(t.cancel);
      expect(html).not.toContain(t.pause);
      expect(html).not.toContain('type="number"');
    },
  );
  it('shows the delay chip, times in the clinic zone and opened time', () => {
    const html = render({
      declaredDelayMinutes: 35,
      openedAt: '2026-09-08T08:05:00.000Z',
    });
    expect(html).toContain('+35 minutes');
    expect(html).toContain('<bdi>09:00</bdi>');
    expect(html).toContain('Ouverte à 09:05');
  });
  it('renders Arabic copy with Western digits', () => {
    const html = render({ declaredDelayMinutes: 5 }, 'ar');
    expect(html).toContain(receptionistCopy.ar.homeOpenConsole);
    expect(html).toContain('<bdi>09:00</bdi>');
  });
});
