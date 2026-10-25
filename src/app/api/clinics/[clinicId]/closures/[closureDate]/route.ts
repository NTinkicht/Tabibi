import { SchedulingService } from '@/modules/scheduling';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  calendarDaySchema,
  clinicIdSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string; closureDate: string }> };

// Removing a day that is not a closure is an idempotent no-op (#649).
export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, closureDate } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const day = calendarDaySchema.parse(closureDate);
    const result = await new SchedulingService(getPool()).removeClosure(
      scope,
      day,
    );
    return { status: 200, body: result };
  });
}
