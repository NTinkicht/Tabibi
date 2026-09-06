import { describe, expect, it } from 'vitest';
import { CLINIC_ROLES } from '@/modules/identity';
import {
  canApplySessionCommand,
  canTransitionSession,
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

  it('distinguishes open from resume and defines every operational command', () => {
    expect(canApplySessionCommand('planned', 'open')).toBe(true);
    expect(canApplySessionCommand('paused', 'open')).toBe(false);
    expect(canApplySessionCommand('paused', 'resume')).toBe(true);
    expect(canApplySessionCommand('open', 'pause')).toBe(true);
    expect(canApplySessionCommand('open', 'close')).toBe(true);
    expect(canApplySessionCommand('planned', 'cancel')).toBe(true);
  });
});
