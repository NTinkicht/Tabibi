import { requireClinicRole } from '@/modules/identity';
import { notificationTemplateCatalogue } from '@/modules/notification-templates/catalogue';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import { authenticatedClinicScope } from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string }> };

// TAB-P1-06 slice 1: read-only. The wording is global, versioned code, so the
// clinic path only scopes who may read it; nothing here is clinic or patient data.
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    await requireClinicRole(getPool(), scope, ['clinic_admin', 'receptionist']);
    return {
      status: 200,
      body: { templates: notificationTemplateCatalogue() },
    };
  });
}
