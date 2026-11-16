import { z } from 'zod';
import { AccountDependentService } from '@/modules/account-dependent';
import { getPool } from '@/platform/database/pool';
import { readBoundedJson } from '@/platform/http/bounded-json';
import { operationalJson } from '@/platform/http/operational-response';
import { authenticatedPatient } from '@/platform/http/patient-auth';
import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';
import { requireSameOrigin } from '@/platform/http/staff-auth';

type Context = { params: Promise<{ dependentId: string }> };

// A dependent that is unknown, malformed, archived (for update) or owned by
// another account is the same 404; the owner comes only from the session.
const MAX_BODY_BYTES = 2048;
const ACCOUNT_LIMIT = 30;
const INGRESS_LIMIT = 600;
const INGRESS_BUCKET = 'patient-dependents:ingress';
const updateSchema = z.object({ displayName: z.string() }).strict();

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    const { dependentId } = await context.params;
    const dependent = await new AccountDependentService(getPool()).get(
      { ownerUserId: patient.userId },
      dependentId,
      { includeArchived: true },
    );
    return { status: 200, body: { dependent } };
  });
}

export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    requireSameOrigin(request);
    const body = updateSchema.parse(
      await readBoundedJson(request, MAX_BODY_BYTES),
    );
    const withinSource = await consumeSignInBudget(
      INGRESS_BUCKET,
      INGRESS_LIMIT,
    );
    const withinAccount = await consumeSignInBudget(
      `patient-dependents:account:${keyDigest(patient.userId)}`,
      ACCOUNT_LIMIT,
    );
    if (!withinSource || !withinAccount) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    const { dependentId } = await context.params;
    const dependent = await new AccountDependentService(getPool()).update(
      { ownerUserId: patient.userId },
      dependentId,
      { displayName: body.displayName },
    );
    return { status: 200, body: { dependent } };
  });
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}
