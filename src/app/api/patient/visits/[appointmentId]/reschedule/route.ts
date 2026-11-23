import { PatientVisitRescheduleService } from '@/modules/patient-visit-history/reschedule';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { authenticatedPatient } from '@/platform/http/patient-auth';
import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';
import { requireSameOrigin } from '@/platform/http/staff-auth';

type Context = { params: Promise<{ appointmentId: string }> };

// TAB-P1-04 slice 6: same-origin, budgeted patient rescheduling of an upcoming
// visit to another planned session of the same doctor. The owner is always the authenticated patient; the path identifier
// only selects among that owner's visits. Repeating the request is idempotent.
const ACCOUNT_LIMIT = 30;
const INGRESS_LIMIT = 300;
const INGRESS_BUCKET = 'patient-visit-reschedule:ingress';

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
      `patient-visit-reschedule:account:${keyDigest(patient.userId)}`,
      ACCOUNT_LIMIT,
    );
    if (!withinSource || !withinAccount) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    const { appointmentId } = await context.params;
    const body = (await request.json().catch(() => null)) as {
      targetSessionId?: unknown;
    } | null;
    if (!body || typeof body.targetSessionId !== 'string')
      return { status: 400, body: { error: 'invalid_request' } };
    const result = await new PatientVisitRescheduleService(
      getPool(),
    ).reschedule(patient.userId, appointmentId, body.targetSessionId);
    return { status: 200, body: result };
  });
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}
