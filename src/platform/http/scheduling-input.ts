import { z } from 'zod';
import {
  CONSULTATION_DURATION_MAX_MINUTES,
  CONSULTATION_DURATION_MIN_MINUTES,
  isCalendarDay,
} from '@/modules/scheduling';

// TAB-P0-02 (#657): shared request shapes for the staff scheduling routes.
// Validation happens after the same-origin and session checks, and rejects
// malformed ids, impossible calendar days and out-of-range values with 400
// before the service or PostgreSQL sees them.
export const clinicIdSchema = z.string().uuid();
export const doctorIdSchema = z.string().uuid();
export const calendarDaySchema = z
  .string()
  .refine(isCalendarDay, 'must be a real YYYY-MM-DD calendar day');
const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

export const createTemplateSchema = z
  .object({
    doctorId: z.string().uuid(),
    weekday: z.number().int().min(0).max(6),
    localStartTime: localTimeSchema,
    localEndTime: localTimeSchema,
    occurrenceIndex: z.number().int().min(0).max(32767),
  })
  .strict()
  .refine((t) => t.localStartTime < t.localEndTime, {
    message: 'localEndTime must be after localStartTime',
  });

export const templateActiveSchema = z.object({ active: z.boolean() }).strict();

export const generationSchema = z
  .object({
    doctorId: z.string().uuid(),
    startDate: calendarDaySchema,
    daysAhead: z.number().int().min(7).max(366).optional(),
  })
  .strict();

export const closureSchema = z
  .object({ closureDate: calendarDaySchema })
  .strict();

export const absenceSchema = z
  .object({ absenceDate: calendarDaySchema })
  .strict();

// TAB-P0-02 (#661): mirrors ConsultationTypeService's own checks (#651) so
// invalid input is a 400 here and never reaches the service's TypeError.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export const createConsultationTypeSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
    label: z
      .string()
      .refine(
        (label) =>
          label.trim().length >= 1 &&
          label.trim().length <= 80 &&
          !CONTROL_CHARACTERS.test(label.trim()),
        'label must be 1-80 characters without control characters',
      ),
    nominalDurationMinutes: z
      .number()
      .int()
      .min(CONSULTATION_DURATION_MIN_MINUTES)
      .max(CONSULTATION_DURATION_MAX_MINUTES),
  })
  .strict();

export const consultationTypeActiveSchema = z
  .object({ active: z.boolean() })
  .strict();

// Only an absent value, "true" or "false" is accepted; anything else is 400.
export const includeInactiveSchema = z
  .enum(['true', 'false'])
  .nullable()
  .transform((value) => value === 'true');
