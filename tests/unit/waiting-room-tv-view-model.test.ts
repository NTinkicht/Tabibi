import { describe, expect, it } from 'vitest';
import {
  buildTvView,
  isStale,
  nextPollDelayMs,
  parseSnapshot,
} from '@/modules/waiting-room/tv-view-model';

const entry = (
  publicDisplayLabel: string,
  state: 'waiting' | 'checked_in' | 'called',
) => ({
  publicDisplayLabel,
  state,
  called: state === 'called',
});

describe('waiting-room TV view model', () => {
  it('lists five checked-in labels, counts the rest and counts waiting without listing them', () => {
    const entries = [
      entry('A-001', 'called'),
      ...['A-002', 'A-003', 'A-004', 'A-005', 'A-006', 'A-007', 'A-008'].map(
        (l) => entry(l, 'checked_in'),
      ),
      entry('A-009', 'waiting'),
      entry('A-010', 'waiting'),
    ];
    const view = buildTvView(entries);
    expect(view.next).toEqual(['A-002', 'A-003', 'A-004', 'A-005', 'A-006']);
    expect(view.moreArrived).toBe(2);
    expect(view.notYetArrived).toBe(2);
    expect(JSON.stringify(view)).not.toContain('A-009');
  });

  it('puts the most recent called ticket first', () => {
    const view = buildTvView([
      entry('A-001', 'called'),
      entry('A-002', 'called'),
    ]);
    expect(view.called).toEqual(['A-002', 'A-001']);
  });

  it('handles an empty session', () => {
    expect(buildTvView([])).toEqual({
      called: [],
      next: [],
      moreArrived: 0,
      notYetArrived: 0,
    });
  });

  it('polls every 15 s and backs off to a 60 s cap', () => {
    expect(nextPollDelayMs(0)).toBe(15_000);
    expect(nextPollDelayMs(1)).toBe(30_000);
    expect(nextPollDelayMs(2)).toBe(60_000);
    expect(nextPollDelayMs(50)).toBe(60_000);
  });

  it('is stale exactly at 60 s without a success and not before', () => {
    expect(isStale(1_000, 60_999)).toBe(false);
    expect(isStale(1_000, 61_000)).toBe(true);
  });

  it('rejects bodies outside the public allow-list shape', () => {
    const ok = {
      session: { pauseStatus: 'paused', declaredDelayMinutes: 20 },
      generatedAt: '2026-11-14T10:00:00.000Z',
      entries: [
        {
          publicDisplayLabel: 'A-001',
          state: 'called',
          called: true,
          patientId: 'x',
        },
      ],
    };
    const parsed = parseSnapshot(ok);
    expect(parsed?.entries[0]).toEqual({
      publicDisplayLabel: 'A-001',
      state: 'called',
      called: true,
    });
    expect(parseSnapshot({ ...ok, generatedAt: 'nope' })).toBeNull();
    expect(
      parseSnapshot({
        ...ok,
        entries: [{ publicDisplayLabel: 'A', state: 'done' }],
      }),
    ).toBeNull();
    expect(
      parseSnapshot({
        ...ok,
        session: { pauseStatus: 'x', declaredDelayMinutes: 0 },
      }),
    ).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
  });
});
