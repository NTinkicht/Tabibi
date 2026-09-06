import { z } from 'zod';
import { QueueService } from '@/modules/queue';
import { getPool } from '@/platform/database/pool';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

const paramsSchema = z.object({
  clinicId: z.string().uuid(),
  sessionId: z.string().uuid(),
  entryId: z.string().uuid(),
});
const bodySchema = z
  .object({
    command: z.enum([
      'check_in',
      'call',
      'no_show',
      'cancel',
      'start_consultation',
      'complete_consultation',
    ]),
    reason: z.string().max(500).optional(),
    cancellationSource: z.enum(['patient', 'clinic']).optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.command === 'cancel' || value.command === 'no_show') &&
      !value.reason?.trim()
    )
      context.addIssue({ code: 'custom', message: 'A reason is required' });
    if (value.command === 'cancel' && !value.cancellationSource)
      context.addIssue({
        code: 'custom',
        message: 'Cancellation source is required',
      });
  });

type Context = {
  params: Promise<{ clinicId: string; sessionId: string; entryId: string }>;
};

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async (correlationId) => {
    requireSameOrigin(request);
    const { clinicId, sessionId, entryId } = paramsSchema.parse(
      await context.params,
    );
    const scope = await authenticatedClinicScope(request, clinicId);
    const input = bodySchema.parse(await request.json());
    const entry = await new QueueService(getPool()).command(
      scope,
      sessionId,
      entryId,
      {
        ...input,
        idempotencyKey: request.headers.get('idempotency-key') ?? '',
        correlationId,
      },
    );
    return { status: 200, body: { entry } };
  });
}
