import { SchedulingService } from '@/modules/scheduling';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  clinicIdSchema,
  closureSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const closures = await new SchedulingService(getPool()).listClosures(scope);
    return { status: 200, body: { closures } };
  });
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const { closureDate } = closureSchema.parse(await request.json());
    const result = await new SchedulingService(getPool()).addClosure(
      scope,
      closureDate,
    );
    return { status: result.created ? 201 : 200, body: result };
  });
}
