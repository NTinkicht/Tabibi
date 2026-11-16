import type { Pool } from 'pg';
import type {
  NotificationDeliveryTarget,
  NotificationDeliveryTargetResolver,
} from '@/modules/notification-domain/delivery-policy';
import type { NotificationIntent } from '@/modules/notification-outbox';

/**
 * Routes a queue intent to `push` only when its queue entry has an active,
 * unexpired binding for the same patient; every other case keeps the inner
 * (in-app) target. The subject identity always comes from the inner
 * server-side resolver, so the consent gate still evaluates the exact patient.
 */
export class PushPreferringTargetResolver
  implements NotificationDeliveryTargetResolver
{
  constructor(
    private readonly pool: Pool,
    private readonly inner: NotificationDeliveryTargetResolver,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async resolveTarget(
    intent: NotificationIntent,
  ): Promise<NotificationDeliveryTarget | null> {
    const target = await this.inner.resolveTarget(intent);
    if (!target || target.subjectKind !== 'visit_patient') return target;
    const queueEntryId = intent.queueEntryId?.trim() ?? '';
    if (!queueEntryId) return target;
    const bound = await this.pool.query(
      `SELECT 1 FROM guest_push_subscriptions s
         JOIN queue_entries q ON q.id=s.queue_entry_id AND q.clinic_id=s.clinic_id
        WHERE s.clinic_id=$1 AND s.queue_entry_id=$2 AND q.patient_id=$3
          AND s.revoked_at IS NULL AND s.expires_at>$4
        LIMIT 1`,
      [intent.clinicId, queueEntryId, target.subjectId, this.clock()],
    );
    return bound.rowCount ? { ...target, channel: 'push' } : target;
  }
}
