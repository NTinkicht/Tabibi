import { ClinicService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  clinicIdSchema,
  doctorSpecialtiesSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string; doctorId: string }> };

// TAB-P0-03 (#687, #669 Q2 = A): this clinic's specialty codes for one of its
// doctors. Authorization stays in ClinicService (clinic_admin only); a doctor
// not associated with this clinic is a 404, whatever clinic it works in.
export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, doctorId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const { specialtyCodes } = doctorSpecialtiesSchema.parse(
      await request.json(),
    );
    const { doctor } = await new ClinicService(getPool()).setDoctorSpecialties(
      scope,
      doctorId,
      specialtyCodes,
    );
    return { status: 200, body: { doctor } };
  });
}
