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

const bookingSchema = z.object({
  patientId: z.string().uuid(),
  scheduledStartAt: z.coerce.date(),
  scheduledEndAt: z.coerce.date(),
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