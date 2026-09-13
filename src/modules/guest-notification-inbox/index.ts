import type { Pool } from 'pg';
import {
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import {
  InAppNotificationInboxRepository,
  type InAppNotificationInboxItem,
  type InAppNotificationInboxStore,
} from '@/modules/notification-inbox';

export interface GuestNotificationInboxSnapshot {
  items: InAppNotificationInboxItem[];
  unreadCount: number;
}

type GuestInboxScope = {
  clinicId: string;
  subjectKind: 'visit_patient';
  subjectId: string;
};

/**
 * Guest-facing application boundary for the durable in-app inbox.
 *
 * The caller supplies only the authenticated guest bearer plus bounded operation
 * input. Clinic and patient identity are derived server-side from the live guest
 * credential and queue entry so request input can never widen subject scope.
 */
export class GuestNotificationInboxService {
  constructor(
    private readonly pool: Pool,
    private readonly guestAccess = new GuestAccessService(pool),
    private readonly inbox: InAppNotificationInboxStore =
      new InAppNotificationInboxRepository(pool),
  ) {}

  private async authorizedScope(bearer: string): Promise<GuestInboxScope> {
    const target = await this.guestAccess.authorize(bearer);
    const result = await this.pool.query<{ patient_id: string }>(
      `SELECT patient_id
         FROM queue_entries
        WHERE id=$1 AND clinic_id=$2 AND session_id=$3`,
      [target.queueEntryId, target.clinicId, target.sessionId],
    );
    const patientId = result.rows[0]?.patient_id;
    if (!patientId) throw new GuestAccessRejectedError();
    return {
      clinicId: target.clinicId,
      subjectKind: 'visit_patient',
      subjectId: patientId,
    };
  }

  async getSnapshot(
    bearer: string,
    limit: number,
  ): Promise<GuestNotificationInboxSnapshot> {
    const scope = await this.authorizedScope(bearer);
    const [items, unreadCount] = await Promise.all([
      this.inbox.listForSubject({ ...scope, limit }),
      this.inbox.unreadCount(scope),
    ]);
    return { items, unreadCount };
  }

  async markRead(
    bearer: string,
    itemId: string,
  ): Promise<InAppNotificationInboxItem | null> {
    const scope = await this.authorizedScope(bearer);
    return this.inbox.markRead({ ...scope, itemId });
  }
}
