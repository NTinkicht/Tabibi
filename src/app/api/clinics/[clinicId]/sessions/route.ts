import { z } from 'zod';
import { SessionService } from '@/modules/session';
import { getPool } from '@/platform/database/pool';
import {
  authenticatedClinicScope,
  requireSameOrigin,
} from '@/platform/http/staff-auth';
import { operationalJson } from '@/platform/http/operational-response';

// A JS Date coercion can silently turn February 30 into March 2. Staff
// scheduling accepts only explicit absolute instants with a real calendar day.
const absoluteInstantSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const day = value.slice(0, 10);
    const calendar = new Date(`${day}T00:00:00.000Z`);
    return (
      Number(day.slice(0, 4)) > 0 &&
      Number.isFinite(calendar.getTime()) &&
      calendar.toISOString().slice(0, 10) === day &&
      Number.isFinite(new Date(value).getTime())
    );
  }, 'Timestamp must contain a real calendar day')
  .transform((value) => new Date(value));

const createSchema = z.object({
  doctorId: z.string().uuid(),
  serviceDate: z.string(),
  startsAt: absoluteInstantSchema,
  endsAt: absoluteInstantSchema,
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
    const sessions = await new SessionService(getPool()).listSessions(
      scope,
      date,
    );
    const clinic = await getPool().query<{ timezone: string }>(
      'SELECT timezone FROM clinics WHERE id = $1',
      [scope.clinicId],
    );
    return {
      status: 200,
      body: { sessions, timezone: clinic.rows[0]?.timezone ?? 'UTC' },
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
