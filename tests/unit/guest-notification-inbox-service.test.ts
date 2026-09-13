import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

const guestAccessMocks = vi.hoisted(() => ({
  authenticatedGuestCredentialId: vi.fn(),
}));

vi.mock('@/modules/guest-access', () => ({
  authenticatedGuestCredentialId: (...args: unknown[]) =>
    guestAccessMocks.authenticatedGuestCredentialId(...args),
  GuestAccessRejectedError: class GuestAccessRejectedError extends Error {},
  GuestAccessService: class GuestAccessService {},
}));

import {
  GuestAccessRejectedError,
  type GuestAccessService,
} from '@/modules/guest-access';
import { GuestNotificationInboxService } from '@/modules/guest-notification-inbox';

const target = {
  clinicId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  queueEntryId: '00000000-0000-4000-8000-000000000003',
};
const patientId = '00000000-0000-4000-8000-000000000004';
const itemId = '00000000-0000-4000-8000-000000000005';
const credentialId = '00000000-0000-4000-8000-000000000006';
const bearer = 'signed-guest-bearer';
const createdAt = new Date('2026-09-13T00:00:00.000Z');

function inboxRow(readAt: Date | null = null) {
  return {
    id: itemId,
    clinic_id: target.clinicId,
    subject_kind: 'visit_patient',
    patient_id: patientId,
    account_user_id: null,
    provider_idempotency_key: 'wu36-unit',
    template_id: 'turn_approaching.v1',
    locale: 'fr',
    direction: 'ltr',
    title: 'Votre tour approche',
    body: 'Il reste 2 passage(s) avant votre tour.',
    created_at: createdAt,
    read_at: readAt,
  };
}

function fixture() {
  guestAccessMocks.authenticatedGuestCredentialId.mockReset();
  guestAccessMocks.authenticatedGuestCredentialId.mockReturnValue(credentialId);
  const authorize = vi.fn().mockResolvedValue(target);
  const release = vi.fn();
  const query = vi.fn(async (text: string) => {
    if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') {
      return { rows: [] };
    }
    if (text.includes('FROM guest_credentials credential')) {
      return {
        rows: [
          {
            clinic_id: target.clinicId,
            session_id: target.sessionId,
            queue_entry_id: target.queueEntryId,
            patient_id: patientId,
          },
        ],
      };
    }
    if (text.includes('count(*)::text')) return { rows: [{ count: '1' }] };
    if (text.includes('UPDATE notification_inbox_items')) {
      return { rows: [inboxRow(new Date('2026-09-13T00:01:00.000Z'))] };
    }
    if (text.includes('FROM notification_inbox_items')) {
      return { rows: [inboxRow()] };
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  const connect = vi.fn().mockResolvedValue({ query, release });
  const service = new GuestNotificationInboxService(
    { connect } as unknown as Pool,
    { authorize } as unknown as GuestAccessService,
  );
  return { service, authorize, connect, query, release };
}

describe('GuestNotificationInboxService', () => {
  it('holds authorization locks and reads items/count from one repeatable-read transaction', async () => {
    const { service, authorize, query, release } = fixture();

    const snapshot = await service.getSnapshot(bearer, 20);

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.unreadCount).toBe(1);
    expect(snapshot.items[0]?.subjectId).toBe(patientId);
    expect(query.mock.calls[0]?.[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(query.mock.calls[1]?.[0]).toContain('FOR SHARE OF credential, entry, session');
    expect(query.mock.calls[1]?.[1]).toEqual([credentialId]);
    expect(authorize).toHaveBeenCalledWith(bearer);
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('marks read only while the same credential/entry/session locks are held', async () => {
    const { service, query } = fixture();

    const item = await service.markRead(bearer, itemId);

    expect(item?.id).toBe(itemId);
    expect(item?.readAt).toBe('2026-09-13T00:01:00.000Z');
    expect(query.mock.calls[1]?.[0]).toContain('FOR SHARE OF credential, entry, session');
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('UPDATE notification_inbox_items'),
      ),
    ).toBe(true);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('fails closed and rolls back when the signed credential cannot resolve a locked target', async () => {
    const { service, authorize, query, release } = fixture();
    query.mockImplementation(async (text: string) => {
      if (text.startsWith('BEGIN') || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('FROM guest_credentials credential')) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(service.getSnapshot(bearer, 20)).rejects.toBeInstanceOf(
      GuestAccessRejectedError,
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
