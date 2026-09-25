import { AppointmentValidationError } from '@/modules/appointment';

/**
 * A clinic's configured arrival grace applies to the scheduled appointment
 * start, not to queue registration, session opening, or a browser clock.
 * Callers must supply the trusted server/transaction instant and clinic policy.
 * This predicate is only eligibility: tenant, role, appointment/queue state
 * and concurrency checks remain mandatory in the transactional bulk command.
 */
export const MAX_ARRIVAL_GRACE_MINUTES = 24 * 60;

export function hasAppointmentArrivalGraceExpired(input: {
  scheduledStartAt: Date;
  observedAt: Date;
  graceMinutes: number;
}): boolean {
  const { scheduledStartAt, observedAt, graceMinutes } = input;
  if (
    !(scheduledStartAt instanceof Date) ||
    !Number.isFinite(scheduledStartAt.getTime()) ||
    !(observedAt instanceof Date) ||
    !Number.isFinite(observedAt.getTime())
  )
    throw new AppointmentValidationError(
      'Valid scheduled start and observed instants are required',
    );
  if (
    !Number.isSafeInteger(graceMinutes) ||
    graceMinutes < 0 ||
    graceMinutes > MAX_ARRIVAL_GRACE_MINUTES
  )
    throw new AppointmentValidationError(
      'Arrival grace minutes must be an integer between 0 and 1440',
    );

  return (
    observedAt.getTime() >=
    scheduledStartAt.getTime() + graceMinutes * 60_000
  );
}
