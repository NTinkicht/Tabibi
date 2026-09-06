import { z } from 'zod';
import { SessionService } from '@/modules/session';
import { getPool } from '@/platform/database/pool';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

const createSchema = z.object({
  doctorId: z.string().uuid(),
  serviceDate: z.string(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});
type Context = { params: Promise<{ clinicId: string }> };
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    const date = new URL(request.url).searchParams.get('date') ?? '';
    return {
      status: 200,
      body: {
        sessions: await new SessionService(getPool()).listSessions(scope, date),
      },
    };
  });
}
export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async (correlationId) => {
    requireSameOrigin(request);
    const { clinicId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    const input = createSchema.parse(await request.json());
    const session = await new SessionService(getPool()).createManual(scope, {
      ...input,
      idempotencyKey: request.headers.get('idempotency-key') ?? '',
      correlationId,
    });
    return { status: 201, body: { session } };
  });
}
