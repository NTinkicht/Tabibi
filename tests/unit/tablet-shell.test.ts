import { describe, expect, it } from 'vitest';
import {
  TABLET_QUERY,
  nextTrapIndex,
} from '@/app/operations/[clinicId]/sessions/[sessionId]/queue/tablet-shell';
import { countsLine } from '@/app/operations/[clinicId]/sessions/[sessionId]/queue/tablet-header';

describe('tablet shell', () => {
  it('uses the spec media query', () => {
    expect(TABLET_QUERY).toBe(
      '(min-width: 700px) and (max-width: 1199px) and (pointer: coarse)',
    );
  });

  it('wraps focus forwards and backwards inside the panel', () => {
    expect(nextTrapIndex(4, 3, false)).toBe(0);
    expect(nextTrapIndex(4, 0, true)).toBe(3);
    expect(nextTrapIndex(4, 1, false)).toBe(2);
    expect(nextTrapIndex(4, -1, false)).toBe(0);
    expect(nextTrapIndex(4, -1, true)).toBe(3);
    expect(nextTrapIndex(0, 0, false)).toBe(-1);
  });
});

describe('tablet header counts line', () => {
  it('renders the four server-derived counts on one line', () => {
    expect(
      countsLine(
        {
          arrived: 'Arrivés',
          notArrived: 'Pas encore arrivés',
          completed: 'Terminés',
          noShow: 'Absents',
        },
        { arrived: 2, notArrived: 1, completed: 0, noShow: 3 },
      ),
    ).toBe('Arrivés 2 · Pas encore arrivés 1 · Terminés 0 · Absents 3');
  });
});
