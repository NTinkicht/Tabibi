import { AuthorizationError } from '@/modules/identity';
import {
  SessionConflictError,
  SessionService,
  SessionValidationError,
  type DelayCommand,
  type LifecycleCommand,
} from '@/modules/session';
import { getPool } from '@/platform/database/pool';
import { authenticatedClinicScope } from '@/platform/http/staff-auth';
import { observedJson } from '@/platform/http/request-context';

const lifecycle = new Set(['open', 'pause', 'resume', 'close', 'cancel']);
const delays = new Set(['delay.declare', 'delay.update', 'delay.clear']);
export async function POST(
  request: Request,
  context: { params: Promise<{ clinicId: string; sessionId: string }> },
) {
  return observedJson(request, async (requestId) => {
    try {
      const { clinicId, sessionId } = await context.params;
      const scope = await authenticatedClinicScope(
        getPool(),
        request,
        clinicId,
      );
      const body = (await request.json()) as Record<string, unknown>;
      const command = body.command;
      const idempotencyKey = request.headers.get('idempotency-key') ?? '';
      const service = new SessionService(getPool());
      const session =
        typeof command === 'string' && lifecycle.has(command)
          ? await service.command(scope, sessionId, {
              command: command as LifecycleCommand,
              idempotencyKey,
              correlationId: requestId,
              reason: typeof body.reason === 'string' ? body.reason : undefined,
            })
          : typeof command === 'string' && delays.has(command)
            ? await service.delay(scope, sessionId, {
                command: command as DelayCommand,
                idempotencyKey,
                correlationId: requestId,
                minutes:
                  typeof body.minutes === 'number' ? body.minutes : undefined,
              })
            : (() => {
                throw new SessionValidationError('Unknown session command');
              })();
      return { status: 200, body: { session } };
    } catch (error) {
      if (error instanceof AuthorizationError)
        return { status: 403, body: { error: 'forbidden' } };
      if (error instanceof SessionValidationError)
        return { status: 400, body: { error: error.message } };
      if (error instanceof SessionConflictError)
        return { status: 409, body: { error: error.message } };
      if (error instanceof SyntaxError)
        return { status: 400, body: { error: 'Invalid JSON' } };
      throw error;
    }
  });
}
