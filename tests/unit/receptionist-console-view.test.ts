import { describe, expect, it } from 'vitest';
import {
  buildConsoleView,
  formatWaitRange,
  steppedDelay,
  type ConsoleEntry,
} from '@/modules/receptionist-dashboard/console-view';
import { receptionistCopy } from '@/modules/localization/receptionist';

let seq = 0;
function entry(over: Partial<ConsoleEntry>): ConsoleEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    state: 'checked_in',
    registrationOrder: seq,
    eligibilityOrder: seq,
    priorityOrder: null,
    publicDisplayLabel: `A-${seq}`,
    privateDisplayName: `Patient ${seq}`,
    preferredLocale: 'fr',
    hasContact: false,
    origin: 'walk_in',
    appointmentStartsAt: null,
    activeConsultationRemainingMinutes: null,
    eta: null,
    ...over,
  };
}

describe('reception console view model', () => {
  it('puts in_consultation before called in serving and keeps terminal entries out', () => {
    const called = entry({ id: 'c', state: 'called' });
    const inC = entry({ id: 'i', state: 'in_consultation' });
    const done = entry({ id: 'd', state: 'completed' });
    const v = buildConsoleView([called, done, inC], 'open');
    expect(v.serving.map((r) => r.entry.id)).toEqual(['i', 'c']);
    expect(v.queue).toHaveLength(0);
  });

  it('orders the queue by the display contract and marks only the first callable as next', () => {
    const w = entry({ id: 'w', state: 'waiting', eligibilityOrder: null });
    const b = entry({ id: 'b', eligibilityOrder: 2 });
    const a = entry({ id: 'a', eligibilityOrder: 1 });
    const p = entry({ id: 'p', eligibilityOrder: 3, priorityOrder: 1 });
    const v = buildConsoleView([w, b, a, p], 'open');
    expect(v.queue.map((r) => r.entry.id)).toEqual(['p', 'a', 'b', 'w']);
    expect(v.queue.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    expect(v.queue.filter((r) => r.isNext).map((r) => r.entry.id)).toEqual([
      'p',
    ]);
    expect(v.nextCallable?.id).toBe('p');
    expect(v.callNextEnabled).toBe(true);
    expect(v.arrivedCount).toBe(3);
    expect(v.notArrivedCount).toBe(1);
  });

  it('never makes a waiting entry callable', () => {
    const v = buildConsoleView(
      [entry({ state: 'waiting', eligibilityOrder: null })],
      'open',
    );
    expect(v.nextCallable).toBeNull();
    expect(v.callNextEnabled).toBe(false);
  });

  it('paused session disables call and start but not check-in or complete', () => {
    const waiting = entry({
      id: 'w',
      state: 'waiting',
      eligibilityOrder: null,
    });
    const checked = entry({ id: 'c' });
    const called = entry({ id: 'k', state: 'called' });
    const inC = entry({ id: 'i', state: 'in_consultation' });
    const v = buildConsoleView([waiting, checked, called, inC], 'paused');
    expect(v.paused).toBe(true);
    expect(v.callNextEnabled).toBe(false);
    const byId = (id: string) =>
      [...v.serving, ...v.queue].find((r) => r.entry.id === id)!.actions;
    expect(byId('w')).toMatchObject({
      primary: 'check_in',
      primaryDisabled: false,
    });
    expect(byId('c')).toMatchObject({ primary: 'call', primaryDisabled: true });
    expect(byId('k')).toMatchObject({
      primary: 'start_consultation',
      primaryDisabled: true,
    });
    expect(byId('i')).toMatchObject({
      primary: 'complete_consultation',
      primaryDisabled: false,
    });
  });

  it('closed or planned sessions offer no enabled command', () => {
    for (const status of ['closed', 'planned', 'cancelled'] as const) {
      const v = buildConsoleView(
        [entry({}), entry({ state: 'called' })],
        status,
      );
      expect(v.callNextEnabled).toBe(false);
      for (const r of [...v.serving, ...v.queue])
        expect(r.actions.primaryDisabled).toBe(true);
    }
  });

  it('panel actions follow QUEUE_COMMAND_SOURCE_STATES and priority rules', () => {
    const v = buildConsoleView(
      [
        entry({ id: 'w', state: 'waiting', eligibilityOrder: null }),
        entry({ id: 'c' }),
        entry({ id: 'p', priorityOrder: 1 }),
        entry({ id: 'k', state: 'called' }),
        entry({ id: 'i', state: 'in_consultation' }),
      ],
      'open',
    );
    const panel = (id: string) =>
      [...v.serving, ...v.queue].find((r) => r.entry.id === id)!.actions.panel;
    expect(panel('w')).toEqual(['prioritise', 'cancel']);
    expect(panel('c')).toEqual(['prioritise', 'no_show', 'cancel']);
    expect(panel('p')).toEqual(['no_show', 'cancel']);
    expect(panel('k')).toEqual(['no_show', 'cancel']);
    expect(panel('i')).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [
      entry({ eligibilityOrder: 2 }),
      entry({ eligibilityOrder: 1 }),
    ];
    const ids = input.map((e) => e.id);
    buildConsoleView(input, 'open');
    expect(input.map((e) => e.id)).toEqual(ids);
  });

  it('formats the canonical ETA range in both locales and never a clock time', () => {
    const range = { minWaitMinutes: 10, maxWaitMinutes: 25 };
    expect(formatWaitRange(range, receptionistCopy.fr)).toBe('≈ 10–25 min');
    expect(formatWaitRange(range, receptionistCopy.ar)).toBe('≈ 10–25 دقيقة');
    expect(
      formatWaitRange(
        { minWaitMinutes: 7, maxWaitMinutes: 7 },
        receptionistCopy.fr,
      ),
    ).toBe('≈ 7 min');
    expect(formatWaitRange(null, receptionistCopy.fr)).toBe('—');
  });

  it('steps the delay by 5 minutes within 0..720', () => {
    expect(steppedDelay(null, 1)).toBe(5);
    expect(steppedDelay(5, -1)).toBe(0);
    expect(steppedDelay(0, -1)).toBe(0);
    expect(steppedDelay(718, 1)).toBe(720);
    expect(steppedDelay(720, 1)).toBe(720);
  });

  it('defines every new console copy key in both locales', () => {
    const keys = [
      'callNext',
      'noneToCall',
      'servingTitle',
      'emptyServing',
      'nextChip',
      'priorityBadge',
      'pausedBanner',
      'presentNow',
      'addToQueue',
      'auditedHint',
      'waitEstimate',
      'waitRange',
      'waitSingle',
      'waitUnknown',
      'remainingConsult',
      'lastAction',
      'queueCount',
      'notArrived',
      'appointmentMeta',
      'walkInMeta',
      'phoneOnFile',
    ] as const;
    for (const locale of ['fr', 'ar'] as const)
      for (const k of keys) expect(receptionistCopy[locale][k]).toBeTruthy();
  });
});
