import { ConsultationTypeService } from '@/modules/scheduling';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  clinicIdSchema,
  createConsultationTypeSchema,
  includeInactiveSchema,
} from '@/platform/http/scheduling-input';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

type Context = { params: Promise<{ clinicId: string }> };

// TAB-P0-02 (#661): the clinic consultation-type catalogue (#651) over the
// staff boundary. Authorization stays in ConsultationTypeService.
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const includeInactive = includeInactiveSchema.parse(
      new URL(request.url).searchParams.get('includeInactive'),
    );
    const consultationTypes = await new ConsultationTypeService(getPool()).list(
      scope,
      { includeInactive },
    );
    return { status: 200, body: { consultationTypes } };
  });
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    requireSameOrigin(request);
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    clinicIdSchema.parse(scope.clinicId);
    const input = createConsultationTypeSchema.parse(await request.json());
    const consultationType = await new ConsultationTypeService(
      getPool(),
    ).create(scope, input);
    return { status: 201, body: { consultationType } };
  });
}
