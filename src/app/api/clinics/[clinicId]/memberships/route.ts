import { ClinicService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { clinicIdSchema } from '@/platform/http/scheduling-input';
import { authenticatedClinicScope } from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string }> };

// TAB-P0-02 (#663): staff assignments of the clinic (clinic admins only,
// enforced by ClinicService).
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const memberships = await new ClinicService(getPool()).listMemberships(
      scope,
    );
    return { status: 200, body: { memberships } };
  });
}
