import { describe, expect, it } from 'vitest';
import {
  TABLET_QUERY,
  nextTrapIndex,
} from '@/app/operations/[clinicId]/sessions/[sessionId]/queue/tablet-shell';

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
