import { z } from 'zod';
import { SessionService } from '@/modules/session';
import { getPool } from '@/platform/database/pool';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';
const schema = z.object({
  command: z.enum(['declare_delay', 'update_delay', 'clear_delay']),
  minutes: z.number().finite().int().optional(),
  expectedVersion: z.number().int().nonnegative(),
});
type Context = { params: Promise<{ clinicId: string; sessionId: string }> };
export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async (correlationId) => {
    requireSameOrigin(request);
    const { clinicId, sessionId } = await context.params;
    const scope = await authenticatedClinicScope(request, clinicId);
    const input = schema.parse(await request.json());
    const session = await new SessionService(getPool()).delay(
      scope,
      sessionId,
      {
        ...input,
        idempotencyKey: request.headers.get('idempotency-key') ?? '',
        correlationId,
      },
    );
    return { status: 200, body: { session } };
  });
}
