import { z } from 'zod';

/**
 * Accept only explicit absolute ISO date-times whose YYYY-MM-DD component is
 * a real proleptic-Gregorian calendar day. JavaScript Date otherwise
 * normalizes impossible dates such as February 30.
 */
export const absoluteInstantSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const day = value.slice(0, 10);
    const calendar = new Date(`${day}T00:00:00.000Z`);
    return (
      Number(day.slice(0, 4)) > 0 &&
      Number.isFinite(calendar.getTime()) &&
      calendar.toISOString().slice(0, 10) === day &&
      Number.isFinite(new Date(value).getTime())
    );
  }, 'Timestamp must contain a real calendar day')
  .transform((value) => new Date(value));
