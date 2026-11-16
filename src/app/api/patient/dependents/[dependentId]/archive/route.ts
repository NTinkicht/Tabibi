import { AccountDependentService } from '@/modules/account-dependent';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { authenticatedPatient } from '@/platform/http/patient-auth';
import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';
import { requireSameOrigin } from '@/platform/http/staff-auth';

type Context = { params: Promise<{ dependentId: string }> };

// Archive is soft and idempotent: archiving an archived dependent returns it.
const ACCOUNT_LIMIT = 30;
const INGRESS_LIMIT = 600;
const INGRESS_BUCKET = 'patient-dependents:ingress';

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    requireSameOrigin(request);
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
    const dependent = await new AccountDependentService(getPool()).archive(
      { ownerUserId: patient.userId },
      dependentId,
    );
    return { status: 200, body: { dependent } };
  });
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}
