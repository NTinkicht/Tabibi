import { SavedDoctorService } from '@/modules/saved-doctor';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { authenticatedPatient } from '@/platform/http/patient-auth';

// TAB-P1-04 slice 1: the signed-in patient's saved doctors. The owner is
// always the authenticated patient; no owner identifier is read from the request.
export async function GET(request: Request): Promise<Response> {
  return operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    const doctors = await new SavedDoctorService(getPool()).list(
      patient.userId,
    );
    return { status: 200, body: { doctors } };
  });
}
