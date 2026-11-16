import type { Pool } from 'pg';
import type {
  NotificationProviderAdapter,
  NotificationProviderDispatchContext,
  NotificationProviderResult,
} from '@/modules/notification-domain';
import type { RenderedNotificationDispatchEnvelope } from '@/modules/notification-domain/rendered-dispatch-envelope';
import type { PushSubscriptionSealer } from './subscription-seal';
import type { WebPushTransport } from './push-transport';

/**
 * `push` channel provider adapter (docs/design/pwa-push.md section 4). It runs
 * only after the dispatch service has applied the consent/preference gate and
 * rendered the generic template. The binding is resolved here, at dispatch
 * time, from the server-side queue entry of the claimed intent and is accepted
 * only when that entry belongs to the exact clinic and patient the consent
 * gate authorised. The endpoint and keys exist in plaintext only in memory for
 * the single send and never reach a result, code, log or error.
 */
const TTL_DEFAULT_SECONDS = 600;
const TTL_DISRUPTION_SECONDS = 1800;
const DISRUPTION_TEMPLATES = new Set([
  'session_delayed.v1',
  'session_cancelled.v1',
  'queue_entry_cancelled.v1',
]);
const URGENT_TEMPLATES = new Set(['patient_called.v1', 'turn_approaching.v1']);

export class PushNotificationProviderAdapter
  implements NotificationProviderAdapter
{
  constructor(
    private readonly deps: {
      pool: Pool;
      sealer: PushSubscriptionSealer;
      transport: Pick<WebPushTransport, 'send'>;
      clock?: () => Date;
    },
  ) {}

  async dispatch(
    request: RenderedNotificationDispatchEnvelope,
    context?: NotificationProviderDispatchContext,
  ): Promise<NotificationProviderResult> {
    const target = context?.deliveryContext.target;
    const clinicId = context?.clinicId?.trim() ?? '';
    const queueEntryId = context?.queueEntryId?.trim() ?? '';
    if (
      request.channel !== 'push' ||
      !context ||
      !target ||
      target.channel !== 'push' ||
      target.subjectKind !== 'visit_patient' ||
      !clinicId ||
      !queueEntryId ||
      !target.subjectId.trim()
    )
      return { kind: 'terminal_failure', code: 'push_context_mismatch' };

    const now = (this.deps.clock ?? (() => new Date()))();
    let binding: { id: string; sealed_subscription: string } | undefined;
    try {
      const found = await this.deps.pool.query<{
        id: string;
        sealed_subscription: string;
      }>(
        `SELECT s.id, s.sealed_subscription
           FROM guest_push_subscriptions s
           JOIN queue_entries q ON q.id=s.queue_entry_id AND q.clinic_id=s.clinic_id
          WHERE s.clinic_id=$1 AND s.queue_entry_id=$2 AND q.patient_id=$3
            AND s.revoked_at IS NULL AND s.expires_at>$4
          ORDER BY s.created_at DESC, s.id LIMIT 1`,
        [clinicId, queueEntryId, target.subjectId.trim(), now],
      );
      binding = found.rows[0];
    } catch {
      return { kind: 'retryable_failure', code: 'push_binding_lookup_failure' };
    }
    if (!binding?.sealed_subscription)
      return { kind: 'terminal_failure', code: 'push_no_channel' };

    let subscription;
    try {
      subscription = this.deps.sealer.open(
        { clinicId, queueEntryId, id: binding.id },
        binding.sealed_subscription,
      );
    } catch {
      return { kind: 'terminal_failure', code: 'push_no_channel' };
    }

    const result = await this.deps.transport.send(subscription, {
      payload: {
        v: 1,
        kind: 'status',
        title: 'Tabibi',
        body: request.body,
        url: '/guest/status',
        tag: request.templateId,
      },
      ttlSeconds: DISRUPTION_TEMPLATES.has(request.templateId)
        ? TTL_DISRUPTION_SECONDS
        : TTL_DEFAULT_SECONDS,
      urgency: URGENT_TEMPLATES.has(request.templateId) ? 'high' : 'normal',
      idempotencyKey: request.providerIdempotencyKey,
    });

    switch (result.kind) {
      case 'delivered':
        return { kind: 'delivered', code: 'push_delivered' };
      case 'gone':
        try {
          await this.deps.pool.query(
            `UPDATE guest_push_subscriptions
                SET revoked_at=$2, revocation_reason='gone', sealed_subscription=NULL
              WHERE id=$1 AND clinic_id=$3 AND revoked_at IS NULL`,
            [binding.id, now, clinicId],
          );
        } catch {
          // The terminal result below still stands; the expiry sweep revokes it.
        }
        return { kind: 'terminal_failure', code: 'push_subscription_gone' };
      case 'rejected':
        return { kind: 'terminal_failure', code: 'push_rejected' };
      case 'unavailable':
        return { kind: 'retryable_failure', code: 'push_unavailable' };
      default:
        return { kind: 'unknown', code: 'push_unknown' };
    }
  }
}
