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

// Remove a member's access to this clinic (gap register G-19, TAB-P1-07).
// clinic_admin only; unknown, malformed or other-clinic users are the same
// 404; the last clinic_admin is a 409.
export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, userId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    await new ClinicService(getPool()).removeMembership(scope, userId);
    return { status: 200, body: { removed: { userId } } };
  });
}
