import { observedJson } from '@/platform/http/request-context';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return observedJson(request, async (requestId) => ({
    status: 200,
    body: { status: 'ok', service: 'tabibi', requestId },
  }));
}
