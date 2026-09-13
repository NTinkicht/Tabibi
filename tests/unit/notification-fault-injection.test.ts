import { describe, expect, it, vi } from 'vitest';
import type { NotificationProviderDispatchContext } from '@/modules/notification-domain';
import { InAppNotificationProviderAdapter } from '@/modules/notification-inbox/provider-adapter';
import type { InAppNotificationInboxStore } from '@/modules/notification-inbox';

function providerContext(): NotificationProviderDispatchContext {
  return {
    clinicId: 'clinic-fault-1',
    deliveryContext: {
      target: {
        subjectKind: 'visit_patient',
        subjectId: 'patient-fault-1',
        channel: 'in_app',
      },
      preference: {
        id: 'pref-fault-1',
        clinicId: 'clinic-fault-1',
        subjectKind: 'visit_patient',
        subjectId: 'patient-fault-1',
        channel: 'in_app',
        preferenceState: 'enabled',
        consentState: 'not_required',
        revision: 1,
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
      },
    },
  };
}

function envelope() {
  return {
    channel: 'in_app' as const,
    locale: 'fr' as const,
    direction: 'ltr' as const,
    templateId: 'turn_approaching.v1' as const,
    title: 'Votre tour approche',
    body: 'Il reste 2 passage(s) avant votre tour.',
    providerIdempotencyKey: 'notification:fault-1',
  };
}

describe('WU44 notification fault injection', () => {
  it('never reports delivered when inbox persistence throws an infrastructure fault', async () => {
    const secretDiagnostic = 'postgres password=do-not-leak';
    const persist = vi.fn(async () => {
      throw new Error(secretDiagnostic);
    });
    const inbox = {
      persist,
      listForSubject: vi.fn(),
      markRead: vi.fn(),
      unreadCount: vi.fn(),
    } satisfies InAppNotificationInboxStore;

    const result = await new InAppNotificationProviderAdapter(inbox).dispatch(
      envelope(),
      providerContext(),
    );

    expect(result).toEqual({
      kind: 'unknown',
      code: 'in_app_persist_exception',
    });
    expect(result).not.toMatchObject({ kind: 'delivered' });
    expect(JSON.stringify(result)).not.toContain(secretDiagnostic);
    expect(persist).toHaveBeenCalledOnce();
  });
});
