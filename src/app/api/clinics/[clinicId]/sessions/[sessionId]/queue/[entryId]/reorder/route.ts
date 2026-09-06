import { z } from 'zod';
import { QueueService } from '@/modules/queue';
import { getPool } from '@/platform/database/pool';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

const paramsSchema = z.object({
  clinicId: z.string().uuid(),
  sessionId: z.string().uuid(),
  entryId: z.string().uuid(),
});
const bodySchema = z.object({
  targetPosition: z.number().int().positive(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});
type Context = {
  params: Promise<{ clinicId: string; sessionId: string; entryId: string }>;
};

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async (correlationId) => {
    requireSameOrigin(request);
    const { clinicId, sessionId, entryId } = paramsSchema.parse(
      await context.params,
    );
    const scope = await authenticatedClinicScope(request, clinicId);
    const input = bodySchema.parse(await request.json());
    const result = await new QueueService(getPool()).reorder(
      scope,
      sessionId,
      entryId,
      {
        ...input,
        idempotencyKey: request.headers.get('idempotency-key') ?? '',
        correlationId,
      },
    );
    return { status: 200, body: result };
  });
}
