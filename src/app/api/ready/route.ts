import { databaseIsReady } from '@/platform/database/pool';
import { observedJson } from '@/platform/http/request-context';

export const dynamic = 'force-dynamic';

export function createReadyHandler(
  readinessCheck: () => Promise<boolean> = databaseIsReady,
): (request: Request) => Promise<Response> {
  return (request) =>
    observedJson(request, async (requestId) => {
      const ready = await readinessCheck();
      return {
        status: ready ? 200 : 503,
        body: { status: ready ? 'ready' : 'not_ready', requestId },
      };
    });
}

export const GET = createReadyHandler();
