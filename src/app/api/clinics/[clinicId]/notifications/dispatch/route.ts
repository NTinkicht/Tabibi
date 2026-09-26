import { z } from 'zod';
import { requireClinicRole } from '@/modules/identity';
import { createQueueInAppNotificationDispatchBatchRunner } from '@/modules/notification-domain/in-app';
import { getPool } from '@/platform/database/pool';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';
import { strictLimit100Schema } from '@/platform/http/query-limit';

const DEFAULT_BATCH_LIMIT = 20;
const paramsSchema = z.object({
  clinicId: z.string().uuid(),
});
const querySchema = z.object({
  limit: strictLimit100Schema.optional(),
});

type Context = { params: Promise<{ clinicId: string }> };

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId } = paramsSchema.parse(await context.params);
    const scope = await authenticatedClinicScope(request, clinicId);
    const pool = getPool();

    await requireClinicRole(pool, scope, ['clinic_admin', 'receptionist']);

    const { limit } = querySchema.parse({
      limit: new URL(request.url).searchParams.get('limit') ?? undefined,
    });
    const summary = await createQueueInAppNotificationDispatchBatchRunner(
      pool,
    ).run({
      clinicId: scope.clinicId,
      limit: limit ?? DEFAULT_BATCH_LIMIT,
    });

    return { status: 200, body: { summary } };
  });
}
