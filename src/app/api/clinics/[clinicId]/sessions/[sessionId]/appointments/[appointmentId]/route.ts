import { z } from 'zod';
import { AppointmentLifecycleService } from '@/modules/appointment/lifecycle';
import { getPool } from '@/platform/database/pool';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

const paramsSchema = z.object({
  clinicId: z.string().uuid(),
  sessionId: z.string().uuid(),
  appointmentId: z.string().uuid(),
});

const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('check_in') }),
  z.object({
    command: z.literal('cancel'),
    reason: z.string().trim().min(1).max(500),
  }),
]);

type Context = {
  params: Promise<{
    clinicId: string;
    sessionId: string;
    appointmentId: string;
  }>;
};

export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async (correlationId) => {
    requireSameOrigin(request);
    const { clinicId, sessionId, appointmentId } = paramsSchema.parse(
      await context.params,
    );
    const scope = await authenticatedClinicScope(request, clinicId);
    const input = commandSchema.parse(await request.json());
    const booking = await new AppointmentLifecycleService(getPool()).command(
      scope,
      sessionId,
      appointmentId,
      {
        ...input,
        idempotencyKey: request.headers.get('idempotency-key') ?? '',
        correlationId,
      },
    );
    return { status: 200, body: { booking } };
  });
}
