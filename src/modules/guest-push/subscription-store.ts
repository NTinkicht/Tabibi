import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import { GuestAccessService } from '@/modules/guest-access';
import type { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { GuestLinkIntentStore } from '@/modules/guest-access/link-intents';
import { pushLinkMaterial } from './push-link-material';
import { inTransaction } from '@/platform/database/transaction';
import {
  PushSubscriptionSealer,
  type PushSubscriptionMaterial,
} from './subscription-seal';

const MAX_ACTIVE_PER_ENTRY = 3;
const BINDING_TTL_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_ENTRY_STATES = [
  'waiting',
  'checked_in',
  'called',
  'in_consultation',
];
const ACTIVE_SESSION_STATES = ['planned', 'open', 'paused'];

export type GuestPushTarget = { clinicId: string; queueEntryId: string };

/** One generic refusal: inactive entry or session, so nothing is revealed. */
export class GuestPushBindingRejectedError extends Error {
  constructor() {
    super('Push subscription binding rejected');
    this.name = 'GuestPushBindingRejectedError';
  }
}

export class GuestPushSubscriptionCapError extends Error {
  constructor() {
    super('Too many push subscriptions for this entry');
    this.name = 'GuestPushSubscriptionCapError';
  }
}

type EntryRow = {
  patient_id: string;
  state: string;
  session_status: string;
};

/**
 * Binding of a Web Push subscription to a queue entry
 * (docs/design/pwa-push.md section 3). Endpoint and keys are only stored
 * sealed; lookups use the keyed endpoint hash. The caller must already have
 * authenticated the guest credential for `target`.
 */
export class GuestPushSubscriptionStore {
  constructor(
    private readonly pool: Pool,
    private readonly sealer: PushSubscriptionSealer,
  ) {}

  async subscribe(
    target: GuestPushTarget,
    material: PushSubscriptionMaterial,
    locale: 'ar' | 'fr',
    now: Date = new Date(),
    /**
     * Booking-origin subscribers only: issue one system push exchange and an
     * `initial` link intent in the same transaction as the binding. A status
     * cookie holder already has access in that browser, so passes nothing.
     */
    initialLink?: { envelope: GuestLinkEnvelope },
  ): Promise<{ subscriptionId: string }> {
    // Validates the allow-list and key shape before any database work.
    const endpointHash = this.sealer.endpointHash(material.endpoint);
    return inTransaction(this.pool, async (client) => {
      const entry = await this.lockEntry(client, target);
      if (
        !ACTIVE_ENTRY_STATES.includes(entry.state) ||
        !ACTIVE_SESSION_STATES.includes(entry.session_status)
      )
        throw new GuestPushBindingRejectedError();

      // Serialize rebinding of one endpoint across entries: locking only the
      // target entry lets two concurrent subscribes both miss each other's
      // binding and collide on the active-endpoint unique index.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`guest-push-endpoint:${endpointHash}`],
      );
      // The same endpoint re-binds instead of duplicating.
      await client.query(
        `UPDATE guest_push_subscriptions
            SET revoked_at=GREATEST($2::timestamptz, created_at), revocation_reason='rotated', sealed_subscription=NULL
          WHERE endpoint_hash=$1 AND revoked_at IS NULL`,
        [endpointHash, now],
      );
      const active = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM guest_push_subscriptions
          WHERE clinic_id=$1 AND queue_entry_id=$2 AND revoked_at IS NULL`,
        [target.clinicId, target.queueEntryId],
      );
      if (Number(active.rows[0]!.n) >= MAX_ACTIVE_PER_ENTRY)
        throw new GuestPushSubscriptionCapError();

      const id = randomUUID();
      const sealed = this.sealer.seal(
        { clinicId: target.clinicId, queueEntryId: target.queueEntryId, id },
        material,
      );
      await client.query(
        `INSERT INTO guest_push_subscriptions
           (id,clinic_id,queue_entry_id,endpoint_hash,sealed_subscription,locale,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          target.clinicId,
          target.queueEntryId,
          endpointHash,
          sealed,
          locale,
          now,
          new Date(now.getTime() + BINDING_TTL_MS),
        ],
      );
      await client.query(
        `INSERT INTO notification_preferences
           (id,clinic_id,subject_kind,patient_id,channel,preference_state,consent_state)
         VALUES($1,$2,'visit_patient',$3,'push','enabled','granted')
         ON CONFLICT (clinic_id,patient_id,account_user_id,channel) DO UPDATE
           SET preference_state='enabled', consent_state='granted',
               revision=notification_preferences.revision+1, updated_at=now()
           WHERE notification_preferences.consent_state<>'granted'
              OR notification_preferences.preference_state<>'enabled'`,
        [randomUUID(), target.clinicId, entry.patient_id],
      );
      if (initialLink) {
        const issued = await new GuestAccessService(
          this.pool,
        ).issueSystemPushInTransaction(
          client,
          {
            clinicId: target.clinicId,
            queueEntryId: target.queueEntryId,
            subscriptionId: id,
          },
          now,
        );
        await new GuestLinkIntentStore(
          this.pool,
          initialLink.envelope,
          () => now,
        ).create(
          {
            clinicId: target.clinicId,
            queueEntryId: target.queueEntryId,
            intent: 'initial',
            material: pushLinkMaterial(issued.exchangeId, id),
            exchangeExpiresAt: issued.expiresAt,
          },
          client,
        );
      }
      await appendAuditEvent(client, {
        clinicId: target.clinicId,
        actorUserId: null,
        entityType: 'queue_entry',
        entityId: target.queueEntryId,
        action: 'guest_push_subscribed',
        metadata: { subscriptionId: id, locale },
      });
      return { subscriptionId: id };
    });
  }

  /**
   * `pushsubscriptionchange` renewal (docs/design/pwa-push.md section 3): the
   * old endpoint must be an active binding of the caller's own entry, else the
   * one generic rejection (a binding of another entry is treated as no match).
   * The old binding is revoked and scrubbed and the new subscription sealed in
   * the same transaction, under the same allow-list and per-entry cap as
   * subscribe. No link is issued, consent is left as it is, and the
   * replacement keeps the old binding's expiry (renewal never extends it).
   */
  async renew(
    target: GuestPushTarget,
    oldEndpoint: string,
    material: PushSubscriptionMaterial,
    now: Date = new Date(),
  ): Promise<{ subscriptionId: string }> {
    // Validates both endpoints against the allow-list before any database work.
    const oldHash = this.sealer.endpointHash(oldEndpoint);
    const newHash = this.sealer.endpointHash(material.endpoint);
    return inTransaction(this.pool, async (client) => {
      const entry = await this.lockEntry(client, target);
      if (
        !ACTIVE_ENTRY_STATES.includes(entry.state) ||
        !ACTIVE_SESSION_STATES.includes(entry.session_status)
      )
        throw new GuestPushBindingRejectedError();

      // Same lock keys as subscribe, taken in a fixed order.
      for (const hash of [...new Set([oldHash, newHash])].sort())
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`guest-push-endpoint:${hash}`],
        );
      // An expired-but-unrevoked binding is no match (a replacement would
      // violate the expiry-order CHECK). The locale is inherited from it.
      const replaced = await client.query<{
        id: string;
        expires_at: Date;
        locale: 'ar' | 'fr';
      }>(
        `UPDATE guest_push_subscriptions
            SET revoked_at=GREATEST($4::timestamptz, created_at), revocation_reason='rotated', sealed_subscription=NULL
          WHERE clinic_id=$1 AND queue_entry_id=$2 AND endpoint_hash=$3
            AND revoked_at IS NULL AND expires_at > $4
          RETURNING id, expires_at, locale`,
        [target.clinicId, target.queueEntryId, oldHash, now],
      );
      const old = replaced.rows[0];
      if (!old) throw new GuestPushBindingRejectedError();
      await client.query(
        `UPDATE guest_push_subscriptions
            SET revoked_at=GREATEST($2::timestamptz, created_at), revocation_reason='rotated', sealed_subscription=NULL
          WHERE endpoint_hash=$1 AND revoked_at IS NULL`,
        [newHash, now],
      );
      const active = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM guest_push_subscriptions
          WHERE clinic_id=$1 AND queue_entry_id=$2 AND revoked_at IS NULL`,
        [target.clinicId, target.queueEntryId],
      );
      if (Number(active.rows[0]!.n) >= MAX_ACTIVE_PER_ENTRY)
        throw new GuestPushSubscriptionCapError();

      const id = randomUUID();
      const sealed = this.sealer.seal(
        { clinicId: target.clinicId, queueEntryId: target.queueEntryId, id },
        material,
      );
      await client.query(
        `INSERT INTO guest_push_subscriptions
           (id,clinic_id,queue_entry_id,endpoint_hash,sealed_subscription,locale,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          target.clinicId,
          target.queueEntryId,
          newHash,
          sealed,
          old.locale,
          now,
          old.expires_at,
        ],
      );
      await appendAuditEvent(client, {
        clinicId: target.clinicId,
        actorUserId: null,
        entityType: 'queue_entry',
        entityId: target.queueEntryId,
        action: 'guest_push_renewed',
        metadata: { subscriptionId: id, replacedId: old.id },
      });
      return { subscriptionId: id };
    });
  }

  /**
   * Revokes and scrubs the entry's binding for `endpoint`, or every active
   * binding of the entry when no endpoint is given. Push consent is revoked
   * once no active binding remains.
   */
  async unsubscribe(
    target: GuestPushTarget,
    endpoint?: string,
    now: Date = new Date(),
  ): Promise<{ revoked: number }> {
    const endpointHash =
      endpoint === undefined ? null : this.sealer.endpointHash(endpoint);
    return inTransaction(this.pool, async (client) => {
      const entry = await this.lockEntry(client, target);
      const revoked = await client.query<{ id: string }>(
        `UPDATE guest_push_subscriptions
            SET revoked_at=$3, revocation_reason='unsubscribed', sealed_subscription=NULL
          WHERE clinic_id=$1 AND queue_entry_id=$2 AND revoked_at IS NULL
            AND ($4::text IS NULL OR endpoint_hash=$4)
          RETURNING id`,
        [target.clinicId, target.queueEntryId, now, endpointHash],
      );
      const remaining = await client.query(
        `SELECT 1 FROM guest_push_subscriptions sub
           JOIN queue_entries qe
             ON qe.id=sub.queue_entry_id AND qe.clinic_id=sub.clinic_id
          WHERE sub.clinic_id=$1 AND qe.patient_id=$2 AND sub.revoked_at IS NULL
          LIMIT 1`,
        [target.clinicId, entry.patient_id],
      );
      // Consent is per patient, so it is revoked only when no entry of the
      // patient keeps an active binding.
      if (remaining.rowCount === 0) {
        await client.query(
          `UPDATE notification_preferences
              SET consent_state='revoked', revision=revision+1, updated_at=now()
            WHERE clinic_id=$1 AND patient_id=$2 AND channel='push'
              AND consent_state='granted'`,
          [target.clinicId, entry.patient_id],
        );
      }
      for (const row of revoked.rows) {
        await appendAuditEvent(client, {
          clinicId: target.clinicId,
          actorUserId: null,
          entityType: 'queue_entry',
          entityId: target.queueEntryId,
          action: 'guest_push_unsubscribed',
          metadata: { subscriptionId: row.id },
        });
      }
      return { revoked: revoked.rowCount ?? 0 };
    });
  }

  private async lockEntry(
    client: PoolClient,
    target: GuestPushTarget,
  ): Promise<EntryRow> {
    const result = await client.query<EntryRow>(
      `SELECT entry.patient_id, entry.state, session.status AS session_status
         FROM queue_entries entry
         JOIN consultation_sessions session
           ON session.id=entry.session_id AND session.clinic_id=entry.clinic_id
        WHERE entry.id=$1 AND entry.clinic_id=$2
        FOR UPDATE OF entry`,
      [target.queueEntryId, target.clinicId],
    );
    const row = result.rows[0];
    if (!row) throw new GuestPushBindingRejectedError();
    return row;
  }
}
