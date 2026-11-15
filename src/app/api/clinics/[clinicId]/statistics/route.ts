import { z } from 'zod';
import { ClinicStatisticsRepository } from '@/modules/clinic-statistics';
import { requireClinicRole } from '@/modules/identity';
import { getPool } from '@/platform/database/pool';
import { authenticatedClinicScope } from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

const querySchema = z.object({ from: z.string(), to: z.string() });

type Context = { params: Promise<{ clinicId: string }> };

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    const pool = getPool();

    await requireClinicRole(pool, scope, ['clinic_admin']);

    const params = new URL(request.url).searchParams;
    const { from, to } = querySchema.parse({
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
    });
    const statistics = await new ClinicStatisticsRepository(pool).forWindow({
      clinicId: scope.clinicId,
      from,
      to,
    });
    return { status: 200, body: statistics };
  });
}
