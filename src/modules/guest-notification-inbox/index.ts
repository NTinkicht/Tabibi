import type { Pool, PoolClient } from 'pg';
import {
  authenticatedGuestCredentialId,
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import type { InAppNotificationInboxItem } from '@/modules/notification-inbox';

export interface GuestNotificationInboxSnapshot {
  items: InAppNotificationInboxItem[];
  unreadCount: number;
}

type GuestInboxScope = {
  clinicId: string;
  subjectKind: 'visit_patient';
  subjectId: string;
};

type LockedGuestTarget = {
  clinic_id: string;
  session_id: string;
  queue_entry_id: string;
  patient_id: string;
};

type InboxRow = {
  id: string;
  clinic_id: string;
  subject_kind: InAppNotificationInboxItem['subjectKind'];
  patient_id: string | null;
  account_user_id: string | null;
  provider_idempotency_key: string;
  template_id: InAppNotificationInboxItem['templateId'];
  locale: InAppNotificationInboxItem['locale'];
  direction: InAppNotificationInboxItem['direction'];
  title: string;
  body: string;
  created_at: Date;
  read_at: Date | null;
};

const inboxColumns = `id, clinic_id, subject_kind, patient_id, account_user_id,
  provider_idempotency_key, template_id, locale, direction, title, body, created_at, read_at`;

function toInboxItem(row: InboxRow): InAppNotificationInboxItem {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    subjectKind: row.subject_kind,
    subjectId: row.patient_id ?? row.account_user_id!,
    providerIdempotencyKey: row.provider_idempotency_key,
    templateId: row.template_id,
    locale: row.locale,
    direction: row.direction,
    title: row.title,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
  };
}

/**
 * Guest-facing application boundary for the durable in-app inbox.
 *
 * The caller supplies only the authenticated guest bearer plus bounded operation
 * input. Clinic and patient identity are derived server-side from the live guest
 * credential and queue entry so request input can never widen subject scope.
 * Credential, queue-entry and session rows are held with SHARE locks for the
 * complete inbox operation, making revocation/transfer/terminalization serialize
 * with the authorized read or mark-read. Snapshot list/count queries execute in
 * one repeatable-read transaction.
 */
export class GuestNotificationInboxService {
  constructor(
    private readonly pool: Pool,
    private readonly guestAccess = new GuestAccessService(pool),
  ) {}

  private async inAuthorizedTransaction<T>(
    bearer: string,
    operation: (client: PoolClient, scope: GuestInboxScope) => Promise<T>,
  ): Promise<T> {
    const credentialId = authenticatedGuestCredentialId(bearer);
    if (!credentialId) throw new GuestAccessRejectedError();

    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      transactionStarted = true;
      const locked = await client.query<LockedGuestTarget>(
        `SELECT credential.clinic_id, credential.session_id,
                credential.queue_entry_id, entry.patient_id
           FROM guest_credentials credential
           JOIN queue_entries entry ON entry.id=credential.queue_entry_id
             AND entry.clinic_id=credential.clinic_id
             AND entry.session_id=credential.session_id
           JOIN consultation_sessions session ON session.id=credential.session_id
             AND session.clinic_id=credential.clinic_id
          WHERE credential.id=$1
          FOR SHARE OF credential, entry, session`,
        [credentialId],
      );
      const row = locked.rows[0];
      if (!row?.patient_id) throw new GuestAccessRejectedError();

      const target = await this.guestAccess.authorize(bearer);
      if (
        target.clinicId !== row.clinic_id ||
        target.sessionId !== row.session_id ||
        target.queueEntryId !== row.queue_entry_id
      ) {
        throw new GuestAccessRejectedError();
      }

      const result = await operation(client, {
        clinicId: row.clinic_id,
        subjectKind: 'visit_patient',
        subjectId: row.patient_id,
      });
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getSnapshot(
    bearer: string,
    limit: number,
  ): Promise<GuestNotificationInboxSnapshot> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Guest inbox limit must be between 1 and 100');
    }

    return this.inAuthorizedTransaction(bearer, async (client, scope) => {
      const itemsResult = await client.query<InboxRow>(
        `SELECT ${inboxColumns}
           FROM notification_inbox_items
          WHERE clinic_id=$1
            AND subject_kind=$2
            AND patient_id=$3
            AND account_user_id IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT $4`,
        [scope.clinicId, scope.subjectKind, scope.subjectId, limit],
      );
      const countResult = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM notification_inbox_items
          WHERE clinic_id=$1
            AND subject_kind=$2
            AND patient_id=$3
            AND account_user_id IS NULL
            AND read_at IS NULL`,
        [scope.clinicId, scope.subjectKind, scope.subjectId],
      );
      return {
        items: itemsResult.rows.map(toInboxItem),
        unreadCount: Number(countResult.rows[0]?.count ?? 0),
      };
    });
  }

  async markRead(
    bearer: string,
    itemId: string,
  ): Promise<InAppNotificationInboxItem | null> {
    return this.inAuthorizedTransaction(bearer, async (client, scope) => {
      const values = [
        itemId,
        scope.clinicId,
        scope.subjectKind,
        scope.subjectId,
      ];
      const updated = await client.query<InboxRow>(
        `UPDATE notification_inbox_items
            SET read_at=now()
          WHERE id=$1
            AND clinic_id=$2
            AND subject_kind=$3
            AND patient_id=$4
            AND account_user_id IS NULL
            AND read_at IS NULL
         RETURNING ${inboxColumns}`,
        values,
      );
      if (updated.rows[0]) return toInboxItem(updated.rows[0]);

      const existing = await client.query<InboxRow>(
        `SELECT ${inboxColumns}
           FROM notification_inbox_items
          WHERE id=$1
            AND clinic_id=$2
            AND subject_kind=$3
            AND patient_id=$4
            AND account_user_id IS NULL`,
        values,
      );
      return existing.rows[0] ? toInboxItem(existing.rows[0]) : null;
    });
  }
}
