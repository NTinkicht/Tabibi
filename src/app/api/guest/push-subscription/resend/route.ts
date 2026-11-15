import {
  GuestPushNotConfiguredError,
  guestPushSealer,
} from '@/modules/guest-push/config';
import { PushEndpointRejectedError } from '@/modules/guest-push/endpoint-policy';
import { consumeGuestPushBucket } from '@/modules/guest-push/rate-limit';
import { resendGuestPushLink } from '@/modules/guest-push/resend';
import { PushSubscriptionSealError } from '@/modules/guest-push/subscription-seal';
import { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { guestBearerSigningSecret } from '@/modules/guest-access';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';
import { readBoundedJson } from '@/platform/http/bounded-json';
import { requireSameOrigin, StaffCsrfError } from '@/platform/http/staff-auth';

// docs/design/pwa-push.md section 3: possession-based resend. Always 202 with
// one body, whether or not an endpoint matched, so it cannot be used to test
// endpoints. Limits: 3 per binding per hour (in the module) plus this global
// ingress bucket.
const HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const MAX_BODY_BYTES = 4096;
const INGRESS_LIMIT = 30;
const INGRESS_BUCKET = 'guest-push-resend:ingress';

const respond = (status: number, body: unknown, extra = {}) =>
  Response.json(body, { status, headers: { ...HEADERS, ...extra } });

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const pool = getPool();
    if (!(await consumeGuestPushBucket(pool, INGRESS_BUCKET, INGRESS_LIMIT)))
      return respond(
        429,
        { error: 'Too many requests' },
        { 'retry-after': '60' },
      );
    const input = await readBoundedJson(request, MAX_BODY_BYTES);
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input) ||
      typeof (input as { endpoint?: unknown }).endpoint !== 'string'
    )
      return respond(400, { error: 'invalid_request' });
    await resendGuestPushLink(
      pool,
      guestPushSealer(),
      new GuestLinkEnvelope(guestBearerSigningSecret()),
      (input as { endpoint: string }).endpoint,
    );
    return respond(202, { accepted: true });
  } catch (error) {
    if (error instanceof StaffCsrfError)
      return respond(403, { error: 'same_origin_required' });
    if (error instanceof GuestPushNotConfiguredError)
      return respond(503, { error: 'push_unavailable' });
    if (
      error instanceof SyntaxError ||
      error instanceof PushEndpointRejectedError ||
      error instanceof PushSubscriptionSealError
    )
      return respond(400, { error: 'invalid_request' });
    getLogger().error('guest push resend request failed');
    return respond(500, { error: 'internal_error' });
  }
}
