import { PatientVisitRescheduleOptionsService } from '@/modules/patient-visit-history/reschedule-options';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { authenticatedPatient } from '@/platform/http/patient-auth';
import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';

type Context = { params: Promise<{ appointmentId: string }> };

// TAB-P1-04 slice 7: read-only list of valid reschedule targets for one of the
// signed-in patient's own upcoming visits. The owner is always the session.
const ACCOUNT_LIMIT = 60;
const INGRESS_LIMIT = 600;
const INGRESS_BUCKET = 'patient-visit-reschedule-options:ingress';

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    const withinSource = await consumeSignInBudget(
      INGRESS_BUCKET,
      INGRESS_LIMIT,
    );
    const withinAccount = await consumeSignInBudget(
      `patient-visit-reschedule-options:account:${keyDigest(patient.userId)}`,
      ACCOUNT_LIMIT,
    );
    if (!withinSource || !withinAccount) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    const { appointmentId } = await context.params;
    const result = await new PatientVisitRescheduleOptionsService(
      getPool(),
    ).list(patient.userId, appointmentId);
    return { status: 200, body: result };
  });
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}
