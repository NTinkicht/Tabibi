import { operationalJson } from '@/platform/http/operational-response';
import {
  CLEARED_PATIENT_SESSION_COOKIE,
  revokePatientSession,
} from '@/platform/http/patient-auth';
import { requireSameOrigin } from '@/platform/http/staff-auth';

// TAB-P1-01 slice 2: patient logout revokes the server-side session row and
// expires the cookie. Same-origin is required before any work; idempotent.
export async function POST(request: Request): Promise<Response> {
  const response = await operationalJson(request, async () => {
    requireSameOrigin(request);
    await revokePatientSession(request);
    return { status: 200, body: { loggedOut: true } };
  });
  if (response.status === 200)
    response.headers.append('set-cookie', CLEARED_PATIENT_SESSION_COOKIE);
  return response;
}
