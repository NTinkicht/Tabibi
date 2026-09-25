import { describe, expect, it } from 'vitest';
import { AppointmentValidationError } from '@/modules/appointment';
import {
  hasAppointmentArrivalGraceExpired,
  MAX_ARRIVAL_GRACE_MINUTES,
} from '@/modules/appointment/waiting-no-show-policy';

const scheduledStartAt = new Date('2026-09-25T08:00:00.000Z');

describe('WU171 — trusted appointment arrival-grace boundary', () => {
  it('does not mark absent waiting appointments early, but qualifies at the exact deadline', () => {
    const graceMinutes = 15;
    expect(
      hasAppointmentArrivalGraceExpired({
        scheduledStartAt,
        observedAt: new Date('2026-09-25T08:14:59.999Z'),
        graceMinutes,
      }),
    ).toBe(false);
    expect(
      hasAppointmentArrivalGraceExpired({
        scheduledStartAt,
        observedAt: new Date('2026-09-25T08:15:00.000Z'),
        graceMinutes,
      }),
    ).toBe(true);
    expect(
      hasAppointmentArrivalGraceExpired({
        scheduledStartAt,
        observedAt: new Date('2026-09-25T09:00:00.000Z'),
        graceMinutes,
      }),
    ).toBe(true);
  });

  it('respects the configured clinic policy without relying on session start or client timezone', () => {
    for (const graceMinutes of [0, 1, 30, MAX_ARRIVAL_GRACE_MINUTES]) {
      const deadline = new Date(
        scheduledStartAt.getTime() + graceMinutes * 60_000,
      );
      expect(
        hasAppointmentArrivalGraceExpired({
          scheduledStartAt,
          observedAt: new Date(deadline.getTime() - 1),
          graceMinutes,
        }),
      ).toBe(false);
      expect(
        hasAppointmentArrivalGraceExpired({
          scheduledStartAt,
          observedAt: deadline,
          graceMinutes,
        }),
      ).toBe(true);
    }
  });

  it('fails closed on invalid timestamps and out-of-policy grace values', () => {
    for (const graceMinutes of [
      -1,
      0.5,
      MAX_ARRIVAL_GRACE_MINUTES + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        hasAppointmentArrivalGraceExpired({
          scheduledStartAt,
          observedAt: new Date('2026-09-25T09:00:00.000Z'),
          graceMinutes,
        }),
      ).toThrow(AppointmentValidationError);
    }
    for (const invalidDate of [new Date(Number.NaN), new Date('invalid')]) {
      expect(() =>
        hasAppointmentArrivalGraceExpired({
          scheduledStartAt: invalidDate,
          observedAt: new Date('2026-09-25T09:00:00.000Z'),
          graceMinutes: 15,
        }),
      ).toThrow(AppointmentValidationError);
      expect(() =>
        hasAppointmentArrivalGraceExpired({
          scheduledStartAt,
          observedAt: invalidDate,
          graceMinutes: 15,
        }),
      ).toThrow(AppointmentValidationError);
    }
  });
});
