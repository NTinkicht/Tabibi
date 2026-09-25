import { z } from 'zod';
import { AppointmentService } from '@/modules/appointment';
import { getPool } from '@/platform/database/pool';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

const paramsSchema = z.object({
  clinicId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

// Never allow Date coercion to normalize an impossible appointment calendar day
// or interpret an offset-free timestamp in a server-local timezone.
const absoluteInstantSchema = z
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

const bookingSchema = z.object({
  patientId: z.string().uuid(),
  dependentId: z.string().max(128).nullable().optional(),
  scheduledStartAt: absoluteInstantSchema,
  scheduledEndAt: absoluteInstantSchema,
  contactPreference: z.enum(['none', 'phone', 'email']).default('none'),
});

type Context = {
  params: Promise<{ clinicId: string; sessionId: string }>;
};

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async (correlationId) => {
    requireSameOrigin(request);
    const { clinicId, sessionId } = paramsSchema.parse(await context.params);
    const scope = await authenticatedClinicScope(request, clinicId);
    const input = bookingSchema.parse(await request.json());
    const booking = await new AppointmentService(
      getPool(),
    ).bookForExistingPatient(scope, sessionId, {
      ...input,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
      correlationId,
    });
    return { status: 201, body: { booking } };
  });
}
