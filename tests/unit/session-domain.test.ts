import { describe, expect, it } from 'vitest';
import { CLINIC_ROLES } from '@/modules/identity';
import {
  canTransitionSession,
  SessionService,
  SessionValidationError,
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

  it('rejects nonexistent service dates before database access', async () => {
    // No DB methods: invalid date errors must be raised before authorization,
    // clinic-local date formatting, or PostgreSQL date normalization.
    const sessions = new SessionService(
      {} as ConstructorParameters<typeof SessionService>[0],
    );
    const scope = { clinicId: 'clinic', actorUserId: 'actor' };
    for (const serviceDate of [
      '2026-02-29',
      '2026-02-30',
      '2028-02-30',
      '2026-04-31',
      '2026-00-01',
      '0000-01-01',
      '2026-09-31',
    ]) {
      await expect(
        sessions.listSessions(scope, serviceDate),
      ).rejects.toBeInstanceOf(SessionValidationError);
      await expect(
        sessions.createManual(scope, {
          doctorId: 'doctor',
          serviceDate,
          startsAt: new Date('2026-09-07T08:00:00.000Z'),
          endsAt: new Date('2026-09-07T09:00:00.000Z'),
          idempotencyKey: 'wu179-invalid-calendar',
          correlationId: 'wu179-invalid-calendar',
        }),
      ).rejects.toBeInstanceOf(SessionValidationError);
    }
  });
});
