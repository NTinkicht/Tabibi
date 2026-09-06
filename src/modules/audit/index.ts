import type { Queryable } from '@/modules/identity';

export type AuditEntity =
  | 'clinic'
  | 'membership'
  | 'doctor'
  | 'schedule_template'
  | 'consultation_session';

export async function appendAuditEvent(
  db: Queryable,
  event: {
    clinicId: string;
    actorUserId: string;
    entityType: AuditEntity;
    entityId: string;
    action: string;
    metadata?: Readonly<Record<string, string | number | boolean | null>>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (clinic_id, actor_user_id, entity_type, entity_id, action, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.clinicId,
      event.actorUserId,
      event.entityType,
      event.entityId,
      event.action,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}
