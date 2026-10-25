import { SchedulingService } from '@/modules/scheduling';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  calendarDaySchema,
  clinicIdSchema,
  doctorIdSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = {
  params: Promise<{ clinicId: string; doctorId: string; absenceDate: string }>;
};

// Removing a day that is not an absence is an idempotent no-op (#655, #659).
export async function DELETE(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId, doctorId, absenceDate } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const doctor = doctorIdSchema.parse(doctorId);
    const day = calendarDaySchema.parse(absenceDate);
    const result = await new SchedulingService(getPool()).removeDoctorAbsence(
      scope,
      { doctorId: doctor, absenceDate: day },
    );
    return { status: 200, body: result };
  });
}
