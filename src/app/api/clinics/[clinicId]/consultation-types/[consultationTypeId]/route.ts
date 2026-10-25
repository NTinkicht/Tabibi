import { ConsultationTypeService } from '@/modules/scheduling';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  clinicIdSchema,
  consultationTypeActiveSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = {
  params: Promise<{ clinicId: string; consultationTypeId: string }>;
};

// Retire or restore a consultation type (#651, #661). A malformed, unknown or
// other-clinic id is the same 404, so the route is not a cross-tenant
// existence oracle; the service denies non-admins before the lookup.
export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, consultationTypeId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const { active } = consultationTypeActiveSchema.parse(await request.json());
    const consultationType = await new ConsultationTypeService(
      getPool(),
    ).setActive(scope, { consultationTypeId, active });
    return { status: 200, body: { consultationType } };
  });
}
