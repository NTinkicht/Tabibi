import { ClinicService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  addDoctorSchema,
  clinicIdSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string }> };

// TAB-P0-02 (#663): the clinic's doctors, so staff can pick a doctorId for
// templates, sessions and absences. Authorization stays in ClinicService.
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const doctors = await new ClinicService(getPool()).listDoctors(scope);
    return { status: 200, body: { doctors } };
  });
}

// TAB-P0-02 (#667): associate an existing member of this clinic as a doctor.
// 201 when the association or the doctor role is new, 200 when unchanged.
// An existing (shared) doctor profile keeps its display name.
export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const input = addDoctorSchema.parse(await request.json());
    const { doctor, changed } = await new ClinicService(getPool()).addDoctor(
      scope,
      input,
    );
    return { status: changed ? 201 : 200, body: { doctor } };
  });
}
