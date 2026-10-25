import { SchedulingService } from '@/modules/scheduling';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  clinicIdSchema,
  templateActiveSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string; templateId: string }> };

// A malformed, unknown or other-clinic template id is the same 404, so the
// route is not a cross-tenant existence oracle (#647, #657).
export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, templateId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const { active } = templateActiveSchema.parse(await request.json());
    const template = await new SchedulingService(getPool()).setTemplateActive(
      scope,
      { templateId, active },
    );
    return { status: 200, body: { template } };
  });
}
