import { z } from 'zod';
import {
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

// TAB-P0-08 (#734): staff-assisted delivery of the single-use guest status
// link (#730 option A). Only an authenticated receptionist or clinic_admin of
// the same clinic can mint one (role and tenant checks live in
// GuestAccessService.issue). The link is returned once in the response body,
// never logged, and the response is no-store.
const paramsSchema = z.object({
  clinicId: z.string().uuid(),
  sessionId: z.string().uuid(),
  entryId: z.string().uuid(),
});

type Context = {
  params: Promise<{ clinicId: string; sessionId: string; entryId: string }>;
};

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async (requestId) => {
    requireSameOrigin(request);
    const { clinicId, sessionId, entryId } = paramsSchema.parse(
      await context.params,
    );
    const scope = await authenticatedClinicScope(request, clinicId);
    // requireSameOrigin guarantees the Origin header matches this request's
    // own host, so the link can only point back at the serving deployment.
    const origin = new URL(request.headers.get('origin') ?? '');
    if (origin.protocol !== 'https:' && origin.hostname !== 'localhost')
      return {
        status: 409,
        body: {
          error: 'conflict',
          message: 'Status links require an HTTPS deployment',
          requestId,
        },
      };
    try {
      const issued = await new GuestAccessService(getPool()).issue(
        { clinicId, sessionId, queueEntryId: entryId },
        scope.actorUserId,
      );
      return {
        status: 201,
        body: {
          statusLink: {
            url: `${origin.origin}/api/guest/exchange/${issued.exchangeId}`,
            expiresAt: issued.expiresAt.toISOString(),
            singleUse: true,
          },
        },
      };
    } catch (error) {
      // Unknown entry, other clinic's entry, inactive entry/session and a
      // missing guest contact all return one indistinguishable response.
      if (error instanceof GuestAccessRejectedError)
        return {
          status: 409,
          body: {
            error: 'conflict',
            message: 'Guest status link unavailable',
            requestId,
          },
        };
      throw error;
    }
  });
}
