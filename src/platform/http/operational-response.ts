import {
  AppointmentConflictError,
  AppointmentValidationError,
} from '@/modules/appointment';
import { AuthorizationError } from '@/modules/identity';
import { QueueConflictError, QueueValidationError } from '@/modules/queue';
import { ReceptionistDashboardNotFoundError } from '@/modules/receptionist-dashboard';
import {
  SessionConflictError,
  SessionValidationError,
} from '@/modules/session';
import { getLogger } from '@/platform/observability/logger';
import { ZodError } from 'zod';
import { correlationId } from './request-context';
import { StaffAuthenticationError, StaffCsrfError } from './staff-auth';

function isPostgresCheckConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23514'
  );
}

export async function operationalJson(
  request: Request,
  handler: (requestId: string) => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  const requestId = correlationId(request);
  try {
    const result = await handler(requestId);
    return Response.json(result.body, {
      status: result.status,
      headers: { 'x-request-id': requestId, 'cache-control': 'no-store' },
    });
  } catch (error) {
    let status = 500;
    let code = 'internal_error';
    if (error instanceof StaffAuthenticationError) {
      status = 401;
      code = 'authentication_required';
    } else if (error instanceof AuthorizationError) {
      status = 403;
      code = 'forbidden';
    } else if (error instanceof StaffCsrfError) {
      status = 403;
      code = 'csrf_rejected';
    } else if (error instanceof ReceptionistDashboardNotFoundError) {
      status = 404;
      code = 'not_found';
    } else if (
      error instanceof AppointmentValidationError ||
      error instanceof SessionValidationError ||
      error instanceof QueueValidationError ||
      error instanceof ZodError ||
      error instanceof SyntaxError
    ) {
      status = 400;
      code = 'invalid_request';
    } else if (
      error instanceof AppointmentConflictError ||
      error instanceof SessionConflictError ||
      error instanceof QueueConflictError ||
      isPostgresCheckConflict(error)
    ) {
      status = 409;
      code = 'conflict';
    }
    if (status === 500)
      getLogger().error(
        { err: error, requestId },
        'operational request failed',
      );
    return Response.json(
      {
        error: code,
        message:
          status === 500 ? 'Unexpected server error' : (error as Error).message,
        requestId,
      },
      {
        status,
        headers: { 'x-request-id': requestId, 'cache-control': 'no-store' },
      },
    );
  }
}
