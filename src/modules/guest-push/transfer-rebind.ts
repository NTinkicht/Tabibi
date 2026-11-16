import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import {
  PushSubscriptionSealError,
  type PushSubscriptionSealer,
} from './subscription-seal';

type SourceBinding = {
  id: string;
  endpoint_hash: string;
  sealed_subscription: string;
  locale: 'ar' | 'fr';
  expires_at: Date;
};

/**
 * Moves the active Web Push bindings of a transferred entry to its target
 * entry (docs/design/pwa-push.md section 3, "Transfer"). Must run inside the
 * caller's transfer transaction, after the source entry row is locked and the
 * target entry exists. Every source binding is revoked and scrubbed. Each
 * unexpired binding is re-sealed under the target's AAD with the same expiry
 * (a transfer never extends a binding). Fail closed: without a sealer, or when
 * a binding cannot be opened, it is dropped rather than copied. The `push`
 * preference is per patient, so it carries over unchanged. Returns the ids of
 * the new bindings.
 */
export async function rebindPushSubscriptionsForTransfer(
  client: PoolClient,
  sealer: PushSubscriptionSealer | undefined,
  entries: { clinicId: string; sourceEntryId: string; targetEntryId: string },
  now: Date = new Date(),
): Promise<string[]> {
  const source = await client.query<SourceBinding>(
    `SELECT id, endpoint_hash, sealed_subscription, locale, expires_at
       FROM guest_push_subscriptions
      WHERE clinic_id=$1 AND queue_entry_id=$2 AND revoked_at IS NULL
      ORDER BY endpoint_hash
      FOR UPDATE`,
    [entries.clinicId, entries.sourceEntryId],
  );
  if (source.rows.length === 0) return [];

  // Same lock key as subscribe and renew, in sorted order.
  for (const row of source.rows)
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`guest-push-endpoint:${row.endpoint_hash}`],
    );

  const moved: string[] = [];
  for (const row of source.rows) {
    const live = row.expires_at.getTime() > now.getTime();
    await client.query(
      `UPDATE guest_push_subscriptions
          SET revoked_at=GREATEST($2::timestamptz, created_at),
              revocation_reason=$3, sealed_subscription=NULL
        WHERE id=$1`,
      [row.id, now, live ? 'terminal' : 'expired'],
    );
    if (!live || !sealer) continue;
    const newId = randomUUID();
    let sealed: string;
    try {
      const material = sealer.open(
        {
          clinicId: entries.clinicId,
          queueEntryId: entries.sourceEntryId,
          id: row.id,
        },
        row.sealed_subscription,
      );
      sealed = sealer.seal(
        {
          clinicId: entries.clinicId,
          queueEntryId: entries.targetEntryId,
          id: newId,
        },
        material,
      );
    } catch (error) {
      if (error instanceof PushSubscriptionSealError) continue;
      throw error;
    }
    await client.query(
      `INSERT INTO guest_push_subscriptions
         (id,clinic_id,queue_entry_id,endpoint_hash,sealed_subscription,locale,created_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newId,
        entries.clinicId,
        entries.targetEntryId,
        row.endpoint_hash,
        sealed,
        row.locale,
        now,
        row.expires_at,
      ],
    );
    moved.push(newId);
  }
  if (moved.length > 0)
    await appendAuditEvent(client, {
      clinicId: entries.clinicId,
      actorUserId: null,
      entityType: 'queue_entry',
      entityId: entries.targetEntryId,
      action: 'guest_push_transferred',
      metadata: {
        sourceQueueEntryId: entries.sourceEntryId,
        count: moved.length,
      },
    });
  return moved;
}
