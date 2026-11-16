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

// TAB-P1-01 slice 7: first account-owned routes behind the patient session.
// The owner is always the authenticated patient; no owner identifier is read
// from the request. Mutations are same-origin, strict-bodied and budgeted.
const MAX_BODY_BYTES = 2048;
const ACCOUNT_LIMIT = 30;
const INGRESS_LIMIT = 600;
const INGRESS_BUCKET = 'patient-dependents:ingress';

const createSchema = z
  .object({ displayName: z.string().min(1).max(200) })
  .strict();
const listSchema = z
  .object({ includeArchived: z.enum(['true', 'false']).optional() })
  .strict();

export async function GET(request: Request): Promise<Response> {
  return operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    const query = listSchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const dependents = await new AccountDependentService(getPool()).list(
      { ownerUserId: patient.userId },
      { includeArchived: query.includeArchived === 'true' },
    );
    return { status: 200, body: { dependents } };
  });
}

export async function POST(request: Request): Promise<Response> {
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    requireSameOrigin(request);
    const body = createSchema.parse(
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
    const dependent = await new AccountDependentService(getPool()).create(
      { ownerUserId: patient.userId },
      { displayName: body.displayName },
    );
    return { status: 201, body: { dependent } };
  });
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}
