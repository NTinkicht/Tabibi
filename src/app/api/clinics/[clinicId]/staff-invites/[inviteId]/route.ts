import { StaffInviteService } from '@/modules/identity/staff-invites';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { clinicIdSchema } from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string; inviteId: string }> };

// G-18 (#824): revoke an open invite (clinic admins only). Unknown, malformed,
// another clinic's, already revoked and accepted invites are the same 404,
// answered only after non-admins were denied.
export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, inviteId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    await new StaffInviteService(getPool()).revoke(scope, inviteId);
    return { status: 200, body: { revoked: { inviteId } } };
  });
}
