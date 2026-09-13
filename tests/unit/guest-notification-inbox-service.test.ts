import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  GuestAccessRejectedError,
  type GuestAccessService,
} from '@/modules/guest-access';
import { GuestNotificationInboxService } from '@/modules/guest-notification-inbox';
import type { InAppNotificationInboxStore } from '@/modules/notification-inbox';

const target = {
  clinicId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  queueEntryId: '00000000-0000-4000-8000-000000000003',
};
const patientId = '00000000-0000-4000-8000-000000000004';
const itemId = '00000000-0000-4000-8000-000000000005';
const bearer = 'signed-guest-bearer';

function fixture() {
  const authorize = vi.fn().mockResolvedValue(target);
  const query = vi.fn().mockResolvedValue({ rows: [{ patient_id: patientId }] });
  const listForSubject = vi.fn().mockResolvedValue([{ id: itemId }]);
  const unreadCount = vi.fn().mockResolvedValue(1);
  const markRead = vi.fn().mockResolvedValue({ id: itemId, readAt: '2026-09-13T00:00:00.000Z' });

  const service = new GuestNotificationInboxService(
    { query } as unknown as Pool,
    { authorize } as unknown as GuestAccessService,
    { listForSubject, unreadCount, markRead } as unknown as InAppNotificationInboxStore,
  );

  return { service, authorize, query, listForSubject, unreadCount, markRead };
}

describe('GuestNotificationInboxService', () => {
  it('derives one exact inbox scope from the authorized bearer target for list and unread count', async () => {
    const { service, authorize, query, listForSubject, unreadCount } = fixture();

    await expect(service.getSnapshot(bearer, 20)).resolves.toEqual({
      items: [{ id: itemId }],
      unreadCount: 1,
    });

    expect(authorize).toHaveBeenCalledWith(bearer);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id=$1 AND clinic_id=$2 AND session_id=$3'),
      [target.queueEntryId, target.clinicId, target.sessionId],
    );
    const scope = {
      clinicId: target.clinicId,
      subjectKind: 'visit_patient',
      subjectId: patientId,
    };
    expect(listForSubject).toHaveBeenCalledWith({ ...scope, limit: 20 });
    expect(unreadCount).toHaveBeenCalledWith(scope);
  });

  it('marks read only inside the same server-derived exact scope', async () => {
    const { service, markRead } = fixture();

    await service.markRead(bearer, itemId);

    expect(markRead).toHaveBeenCalledWith({
      clinicId: target.clinicId,
      subjectKind: 'visit_patient',
      subjectId: patientId,
      itemId,
    });
  });

  it('fails closed when the authorized queue entry cannot resolve a patient', async () => {
    const { service, query, listForSubject, unreadCount, markRead } = fixture();
    query.mockResolvedValue({ rows: [] });

    await expect(service.getSnapshot(bearer, 20)).rejects.toBeInstanceOf(
      GuestAccessRejectedError,
    );
    expect(listForSubject).not.toHaveBeenCalled();
    expect(unreadCount).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
  });
});
