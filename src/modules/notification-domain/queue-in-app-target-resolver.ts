import type { Pool } from 'pg';
import type {
  NotificationDeliveryTarget,
  NotificationDeliveryTargetResolver,
} from '@/modules/notification-domain/delivery-policy';
import type { NotificationIntent } from '@/modules/notification-outbox';

interface QueueTargetRow {
  patient_id: string | null;
}

/**
 * Resolves one queue-backed notification intent to the exact visit-patient
 * subject that owns the clinic-scoped queue entry. No caller-provided subject
 * identity is accepted and no contact value crosses this boundary.
 */
export class QueueInAppNotificationTargetResolver
  implements NotificationDeliveryTargetResolver
{
  constructor(private readonly pool: Pool) {}

  async resolveTarget(
    intent: NotificationIntent,
  ): Promise<NotificationDeliveryTarget | null> {
    const clinicId = intent.clinicId.trim();
    const queueEntryId = intent.queueEntryId?.trim() ?? '';
    if (!clinicId || !queueEntryId) return null;
    if (intent.logicalTargetKey !== `queue-entry:${queueEntryId}`) return null;

    const result = await this.pool.query<QueueTargetRow>(
      `SELECT patient_id
         FROM queue_entries
        WHERE id=$1 AND clinic_id=$2`,
      [queueEntryId, clinicId],
    );
    const patientId = result.rows[0]?.patient_id?.trim() ?? '';
    if (!patientId) return null;

    return {
      subjectKind: 'visit_patient',
      subjectId: patientId,
      channel: 'in_app',
    };
  }
}
