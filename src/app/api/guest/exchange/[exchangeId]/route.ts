import { z } from 'zod';
import {
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';

const paramsSchema = z.object({ exchangeId: z.string().min(40).max(128) });
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

type Context = { params: Promise<{ exchangeId: string }> };

export async function GET(
  _request: Request,
  context: Context,
): Promise<Response> {
  try {
    const { exchangeId } = paramsSchema.parse(await context.params);
    const result = await new GuestAccessService(getPool()).consume(exchangeId);
    const maxAge = Math.max(
      0,
      Math.floor((result.expiresAt.getTime() - Date.now()) / 1000),
    );
    return new Response(null, {
      status: 303,
      headers: {
        ...SECURITY_HEADERS,
        location: '/guest/status',
        'set-cookie': `__Host-tabibi_guest=${result.bearer}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`,
      },
    });
  } catch (error) {
    // The same generic response covers malformed, unknown, expired, and replayed exchanges.
    const rejected =
      error instanceof GuestAccessRejectedError || error instanceof z.ZodError;
    if (!rejected) getLogger().error('guest exchange consumption failed');
    return new Response('Guest access exchange rejected', {
      status: rejected ? 400 : 500,
      headers: SECURITY_HEADERS,
    });
  }
}
