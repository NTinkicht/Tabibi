import { z } from 'zod';
import { requireClinicRole } from '@/modules/identity';
import { NotificationDeadLetterObservabilityRepository } from '@/modules/notification-outbox/observability';
import { getPool } from '@/platform/database/pool';
import { authenticatedClinicScope } from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

type Context = { params: Promise<{ clinicId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    const pool = getPool();

    await requireClinicRole(pool, scope, ['clinic_admin', 'receptionist']);

    const { limit } = querySchema.parse({
      limit: new URL(request.url).searchParams.get('limit') ?? undefined,
    });
    const repository = new NotificationDeadLetterObservabilityRepository(pool);
    const deadLetters = await repository.listRecentForClinic({
      clinicId: scope.clinicId,
      limit,
    });

    return { status: 200, body: { deadLetters } };
  });
}
