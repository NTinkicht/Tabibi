import { randomUUID } from 'node:crypto';
import { getLogger } from '@/platform/observability/logger';

const correlationPattern = /^[A-Za-z0-9._-]{1,128}$/;

export function correlationId(request: Request): string {
  const supplied = request.headers.get('x-request-id');
  return supplied && correlationPattern.test(supplied)
    ? supplied
    : randomUUID();
}

export async function observedJson(
  request: Request,
  handler: (requestId: string) => Promise<{ body: unknown; status: number }>,
): Promise<Response> {
  const requestId = correlationId(request);
  const startedAt = Date.now();
  try {
    const result = await handler(requestId);
    getLogger().info(
      {
        requestId,
        method: request.method,
        status: result.status,
        durationMs: Date.now() - startedAt,
      },
      'request completed',
    );
    return Response.json(result.body, {
      status: result.status,
      headers: { 'x-request-id': requestId },
    });
  } catch (error) {
    getLogger().error(
      { err: error, requestId, method: request.method },
      'request failed',
    );
    return Response.json(
      { status: 'error', requestId },
      { status: 500, headers: { 'x-request-id': requestId } },
    );
  }
}
