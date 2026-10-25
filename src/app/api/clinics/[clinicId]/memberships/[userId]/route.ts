import { ClinicService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  clinicIdSchema,
  membershipRoleSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string; userId: string }> };

// Change an existing member's role (#653 integrity rules, #663). Never adds a
// member: an unknown, malformed or other-clinic user is the same 404, checked
// by the service under the clinic lock after it has denied non-admins.
export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, userId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const { role } = membershipRoleSchema.parse(await request.json());
    await new ClinicService(getPool()).setMembership(scope, userId, role, {
      existingMemberOnly: true,
    });
    return { status: 200, body: { membership: { userId, role } } };
  });
}
