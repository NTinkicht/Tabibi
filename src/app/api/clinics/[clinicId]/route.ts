import { type Clinic, ClinicService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import { updateClinicSchema } from '@/platform/http/clinic-input';
import { operationalJson } from '@/platform/http/operational-response';
import { clinicIdSchema } from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string }> };

// TAB-P0-02 (#665): clinic settings over the staff boundary. Authorization
// stays in ClinicService (any clinic role reads, clinic_admin updates). The
// response is an explicit projection: the internal tenant key is not exposed.
function staffClinic(clinic: Clinic) {
  return {
    id: clinic.id,
    name: clinic.name,
    timezone: clinic.timezone,
    defaultLocale: clinic.defaultLocale,
    enabledLocales: clinic.enabledLocales,
    status: clinic.status,
    wilayaCode: clinic.wilayaCode,
    commune: clinic.commune,
    addressLine: clinic.addressLine,
  };
}

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const clinic = await new ClinicService(getPool()).getClinic(scope);
    return { status: 200, body: { clinic: staffClinic(clinic) } };
  });
}

export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const update = updateClinicSchema.parse(await request.json());
    const clinic = await new ClinicService(getPool()).updateClinic(
      scope,
      update,
    );
    return { status: 200, body: { clinic: staffClinic(clinic) } };
  });
}
