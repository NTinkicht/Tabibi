import { z } from 'zod';
import { PasswordPolicyError } from '@/modules/identity/staff-credentials';
import {
  InviteInputError,
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

const bodySchema = z
  .object({
    token: tokenSchema,
    displayName: z.string().min(1).max(120),
    password: z.string().min(1).max(1024),
  })
  .strict();

// G-18 (#824): redeem a single-use invite into a clinic membership
// (StaffInviteService.accept: one transaction, row-locked, so a concurrent
// double accept has exactly one winner). It does not sign the person in: they
// sign in next with the invited email and their password. An existing account
// that already has a password keeps it.
export async function POST(request: Request): Promise<Response> {
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    requireSameOrigin(request);
    const body = await parseInviteBody(request, bodySchema);
    if (!(await withinInviteRateLimit(body.token))) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    try {
      const accepted = await new StaffInviteService(getPool()).accept(
        body.token,
        { displayName: body.displayName, password: body.password },
      );
      return {
        status: 200,
        body: {
          accepted: { clinicId: accepted.clinicId, role: accepted.role },
        },
      };
    } catch (error) {
      if (error instanceof PasswordPolicyError)
        return {
          status: 400,
          body: { error: 'password_policy', code: error.code },
        };
      if (error instanceof InviteInputError)
        return { status: 400, body: { error: 'invalid_request' } };
      if (error instanceof InviteRejectedError)
        return { status: 400, body: { error: 'invite_invalid' } };
      throw error;
    }
  });
  if (rateLimited)
    response.headers.set('retry-after', String(RATE_WINDOW_SECONDS));
  return response;
}
