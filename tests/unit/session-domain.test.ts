import { describe, expect, it } from 'vitest';
import { CLINIC_ROLES } from '@/modules/identity';
import {
  canApplySessionCommand,
  canTransitionSession,
  type SessionCommand,
  type SessionStatus,
} from '@/modules/session';

describe('session foundation domain rules', () => {
  it('uses only clinic-scoped MVP membership roles', () => {
    expect(CLINIC_ROLES).toEqual(['doctor', 'receptionist', 'clinic_admin']);
  });

  it('permits foundation lifecycle transitions and keeps terminal states terminal', () => {
    expect(canTransitionSession('planned', 'open')).toBe(true);
    expect(canTransitionSession('open', 'paused')).toBe(true);
    expect(canTransitionSession('paused', 'open')).toBe(true);
    expect(canTransitionSession('open', 'closed')).toBe(true);
    expect(canTransitionSession('cancelled', 'open')).toBe(false);
    expect(canTransitionSession('closed', 'open')).toBe(false);
    expect(canTransitionSession('planned', 'paused')).toBe(false);
  });

  it('implements the complete state by operational command matrix', () => {
    const commands: SessionCommand[] = [
      'open',
      'pause',
      'resume',
      'close',
      'cancel',
      'delay_declare',
      'delay_update',
      'delay_clear',
    ];
    const states: SessionStatus[] = [
      'planned',
      'open',
      'paused',
      'closed',
      'cancelled',
    ];
    const expected: Record<SessionStatus, boolean[]> = {
      planned: [true, false, false, false, true, true, true, true],
      open: [false, true, false, true, true, true, true, true],
      paused: [false, false, true, true, true, true, true, true],
      closed: [false, false, false, false, false, false, false, false],
      cancelled: [false, false, false, false, false, false, false, false],
    };
    for (const state of states)
      expect(
        commands.map((command) => canApplySessionCommand(state, command)),
      ).toEqual(expected[state]);
  });
});
