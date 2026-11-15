import { z } from 'zod';
import { requireClinicRole } from '@/modules/identity';
import { NotificationDeadLetterObservabilityRepository } from '@/modules/notification-outbox/observability';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string; intentId: string }> };

// TAB-P1-06 (#871): staff record that a dead-lettered notification was
// handled (for example by a manual call). Idempotent; the response carries
// only the intent id and time, never payload or contact data.
export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, intentId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    const pool = getPool();
    await requireClinicRole(pool, scope, ['clinic_admin', 'receptionist']);
    const id = z.string().uuid().parse(intentId);
    const handled = await new NotificationDeadLetterObservabilityRepository(
      pool,
    ).markHandled({
      clinicId: scope.clinicId,
      intentId: id,
      actorUserId: scope.actorUserId,
    });
    return { status: 200, body: handled };
  });
}
