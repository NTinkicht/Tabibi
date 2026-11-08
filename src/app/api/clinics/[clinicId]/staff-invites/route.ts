import { z } from 'zod';
import {
  INVITABLE_ROLES,
  INVITE_MAX_TTL_SECONDS,
  StaffInviteService,
} from '@/modules/identity/staff-invites';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { clinicIdSchema } from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string }> };

const createInviteSchema = z
  .object({
    email: z.string().min(3).max(320),
    role: z.enum(INVITABLE_ROLES),
    ttlSeconds: z.number().int().min(60).max(INVITE_MAX_TTL_SECONDS).optional(),
  })
  .strict();

// G-18 (#824): a clinic_admin invites a doctor or receptionist. The token is
// in this one response only and never logged. `cache-control: no-store` is
// set by operationalJson on every response, success and error alike (asserted
// in staff-invite-http-api.test.ts); the
// admin's UI turns it into the one-time link /staff/invite#<token>, whose
// fragment never reaches the server.
export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const input = createInviteSchema.parse(await request.json());
    const invite = await new StaffInviteService(getPool()).create(scope, input);
    return {
      status: 201,
      body: {
        invite: {
          inviteId: invite.inviteId,
          token: invite.token,
          expiresAt: invite.expiresAt.toISOString(),
        },
      },
    };
  });
}

// G-18 (#824): the clinic's open invites (clinic admins only). Expired ones
// are listed too: they block a new invite for that email until revoked.
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const invites = await new StaffInviteService(getPool()).listOpen(scope);
    return {
      status: 200,
      body: {
        invites: invites.map((invite) => ({
          inviteId: invite.inviteId,
          email: invite.email,
          role: invite.role,
          status: invite.status,
          createdAt: invite.createdAt.toISOString(),
          expiresAt: invite.expiresAt.toISOString(),
        })),
      },
    };
  });
}
