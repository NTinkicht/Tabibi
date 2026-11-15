import { GuestAccessRejectedError } from '@/modules/guest-access';
import {
  GuestPushNotConfiguredError,
  guestPushSealer,
} from '@/modules/guest-push/config';
import {
  authenticateGuestPush,
  guestPushCredentialId,
} from '@/modules/guest-push/credential';
import { PushEndpointRejectedError } from '@/modules/guest-push/endpoint-policy';
import { consumeGuestPushBucket } from '@/modules/guest-push/rate-limit';
import { PushSubscriptionSealError } from '@/modules/guest-push/subscription-seal';
import {
  GuestPushBindingRejectedError,
  GuestPushSubscriptionCapError,
  GuestPushSubscriptionStore,
} from '@/modules/guest-push/subscription-store';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';
import { readBoundedJson } from '@/platform/http/bounded-json';
import { requireSameOrigin, StaffCsrfError } from '@/platform/http/staff-auth';

// docs/design/pwa-push.md section 3: POST renews a binding after
// `pushsubscriptionchange`. Same entry credential as the subscribe route; the
// old endpoint must be an active binding of that credential's own entry. A
// per-credential and a global ingress bucket apply, and no link is issued.
const HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const MAX_BODY_BYTES = 8192;
const INGRESS_LIMIT = 6;
const CREDENTIAL_LIMIT = 6;
const INGRESS_BUCKET = 'guest-push-renew:ingress';

function respond(status: number, body: unknown, extra = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}

// Matches the `pushsubscriptionchange` handler in public/sw.js: the body is
// `{ oldSubscription, newSubscription }` (PushSubscription.toJSON() shapes,
// no locale). The locale is inherited from the replaced binding.
function parse(input: unknown) {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new SyntaxError('Body must be an object');
  const { oldSubscription, newSubscription } = input as Record<string, unknown>;
  const old = oldSubscription as Record<string, unknown> | null | undefined;
  const sub = newSubscription as Record<string, unknown> | null | undefined;
  const keys = sub?.keys as Record<string, unknown> | null | undefined;
  if (
    typeof old !== 'object' ||
    old === null ||
    typeof old.endpoint !== 'string' ||
    typeof sub !== 'object' ||
    sub === null ||
    typeof sub.endpoint !== 'string' ||
    typeof keys !== 'object' ||
    keys === null ||
    typeof keys.p256dh !== 'string' ||
    typeof keys.auth !== 'string'
  )
    throw new SyntaxError('Invalid renewal');
  return {
    oldEndpoint: old.endpoint,
    material: {
      endpoint: sub.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const pool = getPool();
    const credentialId = guestPushCredentialId(request);
    const allowed = credentialId
      ? await consumeGuestPushBucket(
          pool,
          `guest-push-renew:credential:${credentialId}`,
          CREDENTIAL_LIMIT,
        )
      : await consumeGuestPushBucket(pool, INGRESS_BUCKET, INGRESS_LIMIT);
    if (!allowed)
      return respond(
        429,
        { error: 'Too many requests' },
        { 'retry-after': '60' },
      );

    const auth = await authenticateGuestPush(pool, request);
    const parsed = parse(await readBoundedJson(request, MAX_BODY_BYTES));
    await new GuestPushSubscriptionStore(pool, guestPushSealer()).renew(
      { clinicId: auth.clinicId, queueEntryId: auth.queueEntryId },
      parsed.oldEndpoint,
      parsed.material,
    );
    return respond(200, { renewed: true });
  } catch (error) {
    if (error instanceof StaffCsrfError)
      return respond(403, { error: 'same_origin_required' });
    if (
      error instanceof GuestAccessRejectedError ||
      error instanceof GuestPushBindingRejectedError
    )
      return respond(401, { error: 'Guest access rejected' });
    if (error instanceof GuestPushNotConfiguredError)
      return respond(503, { error: 'push_unavailable' });
    if (
      error instanceof SyntaxError ||
      error instanceof PushEndpointRejectedError ||
      error instanceof PushSubscriptionSealError
    )
      return respond(400, { error: 'invalid_request' });
    if (error instanceof GuestPushSubscriptionCapError)
      return respond(409, { error: 'subscription_limit' });
    getLogger().error('guest push renew request failed');
    return respond(500, { error: 'internal_error' });
  }
}
