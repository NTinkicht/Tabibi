import { z } from 'zod';
import { AppointmentBulkNoShowService } from '@/modules/appointment/bulk-no-show';
import { getPool } from '@/platform/database/pool';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

const schema = z.object({
  reason: z.string().trim().min(1).max(500),
});

type Context = { params: Promise<{ clinicId: string; sessionId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async (correlationId) => {
    requireSameOrigin(request);
    const { clinicId, sessionId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    const input = schema.parse(await request.json());
    const receipt = await new AppointmentBulkNoShowService(
      getPool(),
    ).resolveWaiting(scope, sessionId, {
      reason: input.reason,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
      correlationId,
    });
    return { status: 200, body: { receipt } };
  });
}
