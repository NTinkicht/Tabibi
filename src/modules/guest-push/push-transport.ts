import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { validatePushEndpoint } from './endpoint-policy';
import type { PushSubscriptionMaterial } from './subscription-seal';
import type { VapidConfig } from './vapid-config';

/**
 * Outbound Web Push transport (docs/design/pwa-push.md section 4): VAPID
 * signing and RFC 8291 aes128gcm encryption via `web-push`, a 5 second
 * timeout, no redirects, and only allow-listed hosts. It never logs or throws
 * the endpoint, keys or payload: every outcome is one of the closed results
 * below.
 */
export const PUSH_TIMEOUT_MS = 5_000;

export type PushSendResult =
  | { kind: 'delivered' }
  | { kind: 'gone' }
  | { kind: 'rejected' }
  | { kind: 'unavailable'; retryAfterSeconds?: number }
  | { kind: 'unknown' };

export interface PushSendOptions {
  payload: object;
  ttlSeconds: number;
  urgency?: 'normal' | 'high';
  /** Idempotency key; only its hash reaches the push service as `Topic`. */
  idempotencyKey: string;
}

export type PushFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Buffer;
    redirect: 'manual';
    signal: AbortSignal;
  },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/** First 32 base64url characters of SHA-256(key): collapses retries only. */
export function pushTopic(idempotencyKey: string): string {
  return createHash('sha256')
    .update(idempotencyKey, 'utf8')
    .digest('base64url')
    .slice(0, 32);
}

export function mapPushStatus(
  status: number,
  retryAfter: string | null,
): PushSendResult {
  if (status === 201 || status === 202) return { kind: 'delivered' };
  if (status === 404 || status === 410) return { kind: 'gone' };
  if (status === 400 || status === 403 || status === 413) {
    return { kind: 'rejected' };
  }
  if (status === 429 || (status >= 500 && status <= 599)) {
    const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
    return Number.isFinite(seconds) && seconds >= 0
      ? { kind: 'unavailable', retryAfterSeconds: Math.floor(seconds) }
      : { kind: 'unavailable' };
  }
  // 3xx (redirects are never followed) and any other status: not delivered,
  // and not safe to assume anything about it.
  return { kind: 'rejected' };
}

export class WebPushTransport {
  constructor(
    private readonly vapid: VapidConfig,
    private readonly fetchImpl: PushFetch = (url, init) =>
      fetch(url, { ...init, body: new Uint8Array(init.body) }),
  ) {}

  async send(
    subscription: PushSubscriptionMaterial,
    options: PushSendOptions,
  ): Promise<PushSendResult> {
    let request: ReturnType<typeof webpush.generateRequestDetails>;
    try {
      const endpoint = validatePushEndpoint(subscription.endpoint);
      request = webpush.generateRequestDetails(
        { endpoint, keys: subscription.keys },
        JSON.stringify(options.payload),
        {
          TTL: Math.max(0, Math.floor(options.ttlSeconds)),
          urgency: options.urgency ?? 'normal',
          topic: pushTopic(options.idempotencyKey),
          contentEncoding: 'aes128gcm',
          vapidDetails: this.vapid,
        },
      );
    } catch {
      // Bad subscription material or endpoint: nothing was sent.
      return { kind: 'rejected' };
    }
    try {
      const response = await this.fetchImpl(request.endpoint, {
        method: request.method,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([k, v]) => [k, String(v)]),
        ),
        body: request.body as Buffer,
        redirect: 'manual',
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      return mapPushStatus(
        response.status,
        response.headers.get('retry-after'),
      );
    } catch {
      return { kind: 'unknown' };
    }
  }
}
