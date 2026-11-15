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

// docs/design/pwa-push.md section 3: POST binds and DELETE unbinds a Web Push
// subscription to the caller's queue entry. Credential: the exchange-origin
// status cookie or the booking-origin Authorization bearer, never both.
const HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const MAX_BODY_BYTES = 4096;
const INGRESS_LIMIT = 6;
const CREDENTIAL_LIMIT = 6;
const INGRESS_BUCKET = 'guest-push-subscription:ingress';

function respond(status: number, body: unknown, extra = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}

const badRequest = () => respond(400, { error: 'invalid_request' });

async function body(request: Request): Promise<Record<string, unknown>> {
  const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new SyntaxError('Body must be an object');
  return parsed as Record<string, unknown>;
}

function material(input: Record<string, unknown>) {
  const keys = input.keys as Record<string, unknown> | null | undefined;
  if (
    typeof input.endpoint !== 'string' ||
    typeof keys !== 'object' ||
    keys === null ||
    typeof keys.p256dh !== 'string' ||
    typeof keys.auth !== 'string' ||
    (input.locale !== 'fr' && input.locale !== 'ar')
  )
    throw new SyntaxError('Invalid subscription');
  return {
    material: {
      endpoint: input.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    },
    locale: input.locale as 'ar' | 'fr',
  };
}

async function handle(
  request: Request,
  run: (
    store: GuestPushSubscriptionStore,
    target: { clinicId: string; queueEntryId: string },
  ) => Promise<Response>,
): Promise<Response> {
  try {
    requireSameOrigin(request);
    const pool = getPool();
    const credentialId = guestPushCredentialId(request);
    const allowed = credentialId
      ? await consumeGuestPushBucket(
          pool,
          `guest-push-subscription:credential:${credentialId}`,
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
    const store = new GuestPushSubscriptionStore(pool, guestPushSealer());
    return await run(store, {
      clinicId: auth.clinicId,
      queueEntryId: auth.queueEntryId,
    });
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
      return badRequest();
    if (error instanceof GuestPushSubscriptionCapError)
      return respond(409, { error: 'subscription_limit' });
    getLogger().error('guest push subscription request failed');
    return respond(500, { error: 'internal_error' });
  }
}

export async function POST(request: Request): Promise<Response> {
  return handle(request, async (store, target) => {
    const parsed = material(await body(request));
    await store.subscribe(target, parsed.material, parsed.locale);
    return respond(200, { subscribed: true });
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request, async (store, target) => {
    const input = request.body === null ? {} : await body(request);
    const endpoint = input.endpoint;
    if (endpoint !== undefined && typeof endpoint !== 'string')
      return badRequest();
    await store.unsubscribe(target, endpoint);
    return respond(200, { subscribed: false });
  });
}
