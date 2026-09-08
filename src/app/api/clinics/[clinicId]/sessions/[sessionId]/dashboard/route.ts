import { z } from 'zod';
import { ReceptionistDashboardService } from '@/modules/receptionist-dashboard';
import { getPool } from '@/platform/database/pool';
import { authenticatedClinicScope } from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

const paramsSchema = z.object({
  clinicId: z.string().uuid(),
  sessionId: z.string().uuid(),
});
type Context = { params: Promise<{ clinicId: string; sessionId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId, sessionId } = paramsSchema.parse(await context.params);
    const scope = await authenticatedClinicScope(request, clinicId);
    const dashboard = await new ReceptionistDashboardService(
      getPool(),
    ).getSnapshot(scope, sessionId);
    return { status: 200, body: dashboard };
  });
}
