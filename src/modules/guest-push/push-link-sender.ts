import type { Pool } from 'pg';
import type {
  DispatchContext,
  LinkSender,
} from '@/modules/guest-access/link-intents';
import type { PushSubscriptionSealer } from './subscription-seal';
import type { WebPushTransport } from './push-transport';

/**
 * LinkSender for the `push` channel (docs/design/pwa-push.md section 4).
 * Resolves the entry's most recent active binding at dispatch time, unseals
 * it, and pushes a generic, lock-screen-safe payload carrying only the
 * single-use exchange URL. The exchange id exists in plaintext only in memory
 * between unseal and the encrypted push; it is never logged, put in an error
 * or stored. Without a binding the intent dead-letters as `no_channel`.
 */
const MIN_REMAINING_SECONDS = 60;
const MAX_TTL_SECONDS = 600;

const BODY: Record<string, string> = {
  initial: 'Notifications activées. Touchez pour ouvrir votre suivi.',
  transfer:
    'Votre passage a été déplacé. Touchez pour voir votre nouveau suivi.',
  resend: 'Touchez pour ouvrir votre suivi.',
};

/** The exchange id is the last path segment of the material; see exchange route. */
function exchangeUrl(material: string): string | undefined {
  return /^[A-Za-z0-9_-]{16,256}$/.test(material)
    ? `/api/guest/exchange/${material}`
    : undefined;
}

export function createPushGuestLinkSender(deps: {
  pool: Pool;
  sealer: PushSubscriptionSealer;
  transport: Pick<WebPushTransport, 'send'>;
  clock?: () => Date;
}): LinkSender {
  const clock = deps.clock ?? (() => new Date());
  return async (material: string, context: DispatchContext) => {
    const now = clock();
    const remainingSeconds = Math.floor(
      (context.exchangeExpiresAt.getTime() - now.getTime()) / 1000,
    );
    // Too late to be useful: finish without sending.
    if (remainingSeconds < MIN_REMAINING_SECONDS) return 'no_channel';
    const url = exchangeUrl(material);
    if (!url) return 'rejected';

    const found = await deps.pool.query<{
      id: string;
      sealed_subscription: string;
      locale: string;
    }>(
      `SELECT id, sealed_subscription, locale FROM guest_push_subscriptions
        WHERE clinic_id=$1 AND queue_entry_id=$2
          AND revoked_at IS NULL AND expires_at>$3
        ORDER BY created_at DESC, id LIMIT 1`,
      [context.clinicId, context.queueEntryId, now],
    );
    const binding = found.rows[0];
    if (!binding) return 'no_channel';

    let subscription;
    try {
      subscription = deps.sealer.open(
        {
          clinicId: context.clinicId,
          queueEntryId: context.queueEntryId,
          id: binding.id,
        },
        binding.sealed_subscription,
      );
    } catch {
      return 'no_channel';
    }

    const result = await deps.transport.send(subscription, {
      payload: {
        v: 1,
        kind: 'link',
        title: 'Tabibi',
        body: BODY[context.intent] ?? BODY.resend,
        url,
        tag: 'link',
      },
      ttlSeconds: Math.min(remainingSeconds, MAX_TTL_SECONDS),
      urgency: 'high',
      idempotencyKey: context.idempotencyKey,
    });

    switch (result.kind) {
      case 'delivered':
        return;
      case 'gone':
        await deps.pool.query(
          `UPDATE guest_push_subscriptions
              SET revoked_at=$2, revocation_reason='gone', sealed_subscription=NULL
            WHERE id=$1 AND clinic_id=$3 AND revoked_at IS NULL`,
          [binding.id, now, context.clinicId],
        );
        return 'gone';
      case 'rejected':
        return 'rejected';
      default:
        // unavailable or unknown: retryable, no detail kept.
        throw new Error('push_unavailable');
    }
  };
}
