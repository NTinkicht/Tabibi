import { describe, expect, it } from 'vitest';
import {
  applySessionCommand,
  canTransitionSession,
  DELAY_COMMANDS,
  type DelayCommand,
  type DelayRefusal,
  isTerminalSessionStatus,
  isValidDelayMinutes,
  MAX_DELAY_MINUTES,
  planDelayCommand,
  SESSION_CANCELLATION_BLOCKING_QUEUE_STATES,
  SESSION_CANCELLATION_CASCADE_QUEUE_STATES,
  SESSION_COMMANDS,
  SESSION_LIFECYCLE_CONTRACT_VERSION,
  SESSION_STATUSES,
  sessionCancellationBlockedBy,
  type SessionCommand,
  sessionCommandRequiresDoctorLock,
  sessionCommandRequiresReason,
  type SessionStatus,
} from '@/modules/session/lifecycle-contract';
import * as sessionModule from '@/modules/session';

describe('session lifecycle contract (TAB-P0-04)', () => {
  it('is versioned and re-exported by the session module', () => {
    expect(SESSION_LIFECYCLE_CONTRACT_VERSION).toBe('session-lifecycle/v2');
    expect(sessionModule.canTransitionSession).toBe(canTransitionSession);
    expect(sessionModule.MAX_DELAY_MINUTES).toBe(MAX_DELAY_MINUTES);
    expect(MAX_DELAY_MINUTES).toBe(720);
  });

  // Rows: from; columns: to, in SESSION_STATUSES order.
  const transitionMatrix: Record<SessionStatus, boolean[]> = {
    //         planned open   paused closed cancelled
    planned: [false, true, false, false, true],
    open: [false, false, true, true, true],
    paused: [false, true, false, true, true],
    closed: [false, false, false, false, false],
    cancelled: [false, false, false, false, false],
  };

  it('enforces the full 5x5 status transition matrix', () => {
    for (const from of SESSION_STATUSES)
      SESSION_STATUSES.forEach((to, index) =>
        expect([from, to, canTransitionSession(from, to)]).toEqual([
          from,
          to,
          transitionMatrix[from][index],
        ]),
      );
  });

  it('treats exactly closed and cancelled as terminal', () => {
    expect(SESSION_STATUSES.filter(isTerminalSessionStatus)).toEqual([
      'closed',
      'cancelled',
    ]);
  });

  // Rows: command; columns: from status, in SESSION_STATUSES order.
  const commandMatrix: Record<SessionCommand, (SessionStatus | null)[]> = {
    //       planned      open         paused       closed cancelled
    open: ['open', null, 'open', null, null],
    pause: [null, 'paused', null, null, null],
    resume: ['open', null, 'open', null, null],
    close: [null, 'closed', 'closed', null, null],
    cancel: ['cancelled', 'cancelled', 'cancelled', null, null],
  };

  it('enforces the full 5x5 command x status matrix', () => {
    for (const command of SESSION_COMMANDS)
      SESSION_STATUSES.forEach((from, index) =>
        expect([command, from, applySessionCommand(command, from)]).toEqual([
          command,
          from,
          commandMatrix[command][index],
        ]),
      );
  });

  it('requires a reason only for cancel and the doctor lock only for open/resume', () => {
    expect(SESSION_COMMANDS.filter(sessionCommandRequiresReason)).toEqual([
      'cancel',
    ]);
    expect(SESSION_COMMANDS.filter(sessionCommandRequiresDoctorLock)).toEqual([
      'open',
      'resume',
    ]);
  });

  it('cascades session cancellation only to non-started live queue states', () => {
    expect([...SESSION_CANCELLATION_CASCADE_QUEUE_STATES]).toEqual([
      'waiting',
      'checked_in',
      'called',
    ]);
  });

  it('blocks whole-session cancellation only on an active consultation (v2)', () => {
    expect([...SESSION_CANCELLATION_BLOCKING_QUEUE_STATES]).toEqual([
      'in_consultation',
    ]);
    const queueStates = [
      'waiting',
      'checked_in',
      'called',
      'in_consultation',
      'completed',
      'cancelled',
      'no_show',
    ];
    for (const state of queueStates)
      expect([state, sessionCancellationBlockedBy([state])]).toEqual([
        state,
        state === 'in_consultation',
      ]);
    expect(sessionCancellationBlockedBy([])).toBe(false);
    expect(
      sessionCancellationBlockedBy(['waiting', 'completed', 'no_show']),
    ).toBe(false);
    expect(
      sessionCancellationBlockedBy(['waiting', 'in_consultation', 'called']),
    ).toBe(true);
    // Blocking and cascading states never overlap.
    for (const state of SESSION_CANCELLATION_BLOCKING_QUEUE_STATES)
      expect(
        (
          SESSION_CANCELLATION_CASCADE_QUEUE_STATES as readonly string[]
        ).includes(state),
      ).toBe(false);
  });

  it('validates delay minutes as whole numbers in 1..720 except for clear', () => {
    const vectors: [number | undefined, boolean][] = [
      [1, true],
      [45, true],
      [720, true],
      [0, false],
      [-1, false],
      [721, false],
      [1.5, false],
      [Number.NaN, false],
      [Number.POSITIVE_INFINITY, false],
      [Number.NEGATIVE_INFINITY, false],
      [undefined, false],
    ];
    for (const command of ['declare_delay', 'update_delay'] as const)
      for (const [minutes, valid] of vectors)
        expect([
          command,
          minutes,
          isValidDelayMinutes(command, minutes),
        ]).toEqual([command, minutes, valid]);
    for (const [minutes] of vectors)
      expect(isValidDelayMinutes('clear_delay', minutes)).toBe(true);
  });

  function expectedDelayOutcome(
    command: DelayCommand,
    status: SessionStatus,
    hasDelay: boolean,
    fresh: boolean,
  ): DelayRefusal | 'ok' {
    if (status === 'closed' || status === 'cancelled')
      return 'terminal_session';
    if (!fresh) return 'stale_version';
    if (command === 'declare_delay')
      return hasDelay ? 'already_declared' : 'ok';
    if (command === 'update_delay')
      return hasDelay ? 'ok' : 'no_delay_to_update';
    return hasDelay ? 'ok' : 'no_delay_to_clear';
  }

  it('decides the full delay command x status x delay x version matrix in check order', () => {
    let cases = 0;
    for (const command of DELAY_COMMANDS)
      for (const status of SESSION_STATUSES)
        for (const hasDelay of [false, true])
          for (const fresh of [true, false]) {
            const plan = planDelayCommand(
              command,
              {
                status,
                declaredDelayMinutes: hasDelay ? 30 : null,
                delayVersion: 4,
              },
              { minutes: 50, expectedVersion: fresh ? 4 : 3 },
            );
            const expected = expectedDelayOutcome(
              command,
              status,
              hasDelay,
              fresh,
            );
            expect([command, status, hasDelay, fresh, plan]).toEqual([
              command,
              status,
              hasDelay,
              fresh,
              expected === 'ok'
                ? {
                    ok: true,
                    minutes: command === 'clear_delay' ? null : 50,
                    nextVersion: 5,
                  }
                : { ok: false, refusal: expected },
            ]);
            cases += 1;
          }
    expect(cases).toBe(3 * 5 * 2 * 2);
  });

  it('rejects a version ahead of the committed one as stale', () => {
    expect(
      planDelayCommand(
        'declare_delay',
        { status: 'open', declaredDelayMinutes: null, delayVersion: 0 },
        { minutes: 10, expectedVersion: 1 },
      ),
    ).toEqual({ ok: false, refusal: 'stale_version' });
  });
});
