import {
  GuestAccessRejectedError,
} from '@/modules/guest-access';
import { GuestStatusService } from '@/modules/guest-status';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

function guestBearer(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === '__Host-tabibi_guest') {
      const value = valueParts.join('=');
      return value || null;
    }
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const bearer = guestBearer(request);
    if (!bearer) throw new GuestAccessRejectedError();
    const snapshot = await new GuestStatusService(getPool()).getSnapshot(bearer);
    return Response.json(snapshot, { status: 200, headers: SECURITY_HEADERS });
  } catch (error) {
    const rejected = error instanceof GuestAccessRejectedError;
    if (!rejected) getLogger().error('guest status read failed');
    return Response.json(
      { error: 'Guest access rejected' },
      { status: rejected ? 401 : 500, headers: SECURITY_HEADERS },
    );
  }
}
