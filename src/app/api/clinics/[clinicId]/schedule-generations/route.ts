import { SchedulingService } from '@/modules/scheduling';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  clinicIdSchema,
  generationSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string }> };

// Generation is idempotent (stable occurrence ids), so a retried request plans
// nothing twice and reports `generated: 0` for already planned occurrences.
export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const input = generationSchema.parse(await request.json());
    const generated = await new SchedulingService(getPool()).generateSessions(
      scope,
      input,
    );
    return { status: 200, body: { generated } };
  });
}
