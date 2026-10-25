import { z } from 'zod';
import { isCalendarDay } from '@/modules/scheduling';

// TAB-P0-02 (#657): shared request shapes for the staff scheduling routes.
// Validation happens after the same-origin and session checks, and rejects
// malformed ids, impossible calendar days and out-of-range values with 400
// before the service or PostgreSQL sees them.
export const clinicIdSchema = z.string().uuid();
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

export const templateActiveSchema = z
  .object({ active: z.boolean() })
  .strict();

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
