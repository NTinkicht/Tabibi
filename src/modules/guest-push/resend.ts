import type { Pool } from 'pg';
import {
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import type { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { GuestLinkIntentStore } from '@/modules/guest-access/link-intents';
import { appendAuditEvent } from '@/modules/audit';
import { inTransaction } from '@/platform/database/transaction';
import { consumeGuestPushBucket } from './rate-limit';
import type { PushSubscriptionSealer } from './subscription-seal';

const PER_BINDING_LIMIT = 3;
const PER_BINDING_WINDOW_MS = 60 * 60 * 1_000;

/**
 * Possession-based resend (docs/design/pwa-push.md section 3). The endpoint
 * alone is enough because the link is only ever delivered to that
 * subscription. Whether or not a binding matched, was rate limited or was
 * inactive, the caller observes nothing: this returns void and never throws
 * for those outcomes, so the route can answer one identical 202.
 */
export async function resendGuestPushLink(
  pool: Pool,
  sealer: PushSubscriptionSealer,
  envelope: GuestLinkEnvelope,
  endpoint: string,
  now: Date = new Date(),
): Promise<void> {
  // Throws PushEndpointRejectedError for hosts outside the allow-list.
  const endpointHash = sealer.endpointHash(endpoint);
  const found = await pool.query<{
    id: string;
    clinic_id: string;
    queue_entry_id: string;
  }>(
    `SELECT id, clinic_id, queue_entry_id FROM guest_push_subscriptions
      WHERE endpoint_hash=$1 AND revoked_at IS NULL AND expires_at>$2`,
    [endpointHash, now],
  );
  const binding = found.rows[0];
  if (!binding) return;
  if (
    !(await consumeGuestPushBucket(
      pool,
      `guest-push-resend:binding:${binding.id}`,
      PER_BINDING_LIMIT,
      PER_BINDING_WINDOW_MS,
    ))
  )
    return;
  try {
    await inTransaction(pool, async (client) => {
      const issued = await new GuestAccessService(
        pool,
      ).issueSystemPushInTransaction(
        client,
        {
          clinicId: binding.clinic_id,
          queueEntryId: binding.queue_entry_id,
          subscriptionId: binding.id,
        },
        now,
      );
      await new GuestLinkIntentStore(pool, envelope, () => now).create(
        {
          clinicId: binding.clinic_id,
          queueEntryId: binding.queue_entry_id,
          intent: 'resend',
          material: issued.exchangeId,
          exchangeExpiresAt: issued.expiresAt,
        },
        client,
      );
      await appendAuditEvent(client, {
        clinicId: binding.clinic_id,
        actorUserId: null,
        entityType: 'queue_entry',
        entityId: binding.queue_entry_id,
        action: 'guest_push_link_resend_requested',
        metadata: { subscriptionId: binding.id },
      });
    });
  } catch (error) {
    // Inactive entry or session: indistinguishable from "no binding".
    if (!(error instanceof GuestAccessRejectedError)) throw error;
  }
}
