import { SchedulingService } from '@/modules/scheduling';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  absenceSchema,
  clinicIdSchema,
  doctorIdSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string; doctorId: string }> };

// TAB-P0-02 (#659): per-doctor absence days over the staff boundary.
// Authorization stays in SchedulingService (#655).
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId, doctorId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const doctor = doctorIdSchema.parse(doctorId);
    const absences = await new SchedulingService(getPool()).listDoctorAbsences(
      scope,
      doctor,
    );
    return { status: 200, body: { absences } };
  });
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, doctorId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const doctor = doctorIdSchema.parse(doctorId);
    const { absenceDate } = absenceSchema.parse(await request.json());
    const result = await new SchedulingService(getPool()).addDoctorAbsence(
      scope,
      { doctorId: doctor, absenceDate },
    );
    return { status: result.created ? 201 : 200, body: result };
  });
}
