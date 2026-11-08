import { z } from 'zod';
import {
  InviteRejectedError,
  StaffInviteService,
} from '@/modules/identity/staff-invites';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { requireSameOrigin } from '@/platform/http/staff-auth';
import {
  RATE_WINDOW_SECONDS,
  parseInviteBody,
  tokenSchema,
  withinInviteRateLimit,
} from '../token-request';

const bodySchema = z.object({ token: tokenSchema }).strict();

// G-18 (#824): what an invite grants (clinic name, role, invited email,
// expiry) so the accept page can say it before the person sets a password.
// Every unusable token is the same 400 `invite_invalid`.
export async function POST(request: Request): Promise<Response> {
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    requireSameOrigin(request);
    const { token } = await parseInviteBody(request, bodySchema);
    if (!(await withinInviteRateLimit(token))) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    try {
      const preview = await new StaffInviteService(getPool()).preview(token);
      return {
        status: 200,
        body: {
          invite: {
            clinicName: preview.clinicName,
            email: preview.email,
            role: preview.role,
            expiresAt: preview.expiresAt.toISOString(),
          },
        },
      };
    } catch (error) {
      if (error instanceof InviteRejectedError)
        return { status: 400, body: { error: 'invite_invalid' } };
      throw error;
    }
  });
  if (rateLimited)
    response.headers.set('retry-after', String(RATE_WINDOW_SECONDS));
  return response;
}
