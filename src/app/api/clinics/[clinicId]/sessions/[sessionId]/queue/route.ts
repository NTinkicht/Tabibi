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
});

const registrationSchema = z.object({
  privateDisplayName: z.string().trim().min(1).max(120),
  contactPhone: z.string().trim().min(3).max(32).optional().nullable(),
  contactEmail: z.string().trim().email().max(254).optional().nullable(),
  preferredLocale: z.enum(['ar', 'fr']),
});

type Context = {
  params: Promise<{ clinicId: string; sessionId: string }>;
};

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async () => {
    const { clinicId, sessionId } = paramsSchema.parse(await context.params);
    const scope = await authenticatedClinicScope(request, clinicId);
    const entries = await new QueueService(getPool()).listWaiting(
      scope,
      sessionId,
    );
    return { status: 200, body: { entries } };
  });
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  return operationalJson(request, async (correlationId) => {
    requireSameOrigin(request);
    const { clinicId, sessionId } = paramsSchema.parse(await context.params);
    const scope = await authenticatedClinicScope(request, clinicId);
    const input = registrationSchema.parse(await request.json());
    const registration = await new QueueService(getPool()).registerWalkIn(
      scope,
      sessionId,
      {
        ...input,
        idempotencyKey: request.headers.get('idempotency-key') ?? '',
        correlationId,
      },
    );
    return { status: 201, body: { registration } };
  });
}
