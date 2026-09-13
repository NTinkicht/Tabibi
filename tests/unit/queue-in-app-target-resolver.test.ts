import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { QueueInAppNotificationTargetResolver } from '@/modules/notification-domain/queue-in-app-target-resolver';
import type { NotificationIntent } from '@/modules/notification-outbox';

function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    id: 'intent-1',
    clinicId: 'clinic-1',
    queueEntryId: 'entry-1',
    logicalTargetKey: 'queue-entry:entry-1',
    eventKey: 'turn_approaching',
    intentVersion: 1,
    idempotencyKey: 'queue-event:event-1',
    state: 'pending',
    payload: { position: 2 },
    supersededById: null,
    createdAt: '2026-09-13T12:00:00.000Z',
    supersededAt: null,
    dispatchAttemptCount: 0,
    dispatchLastAttemptAt: null,
    dispatchOutcomeAt: null,
    dispatchOutcomeCode: null,
    nextAttemptAt: null,
    dispatchMaxAttempts: 3,
    ...overrides,
  };
}

function fixture(rows: Array<{ patient_id: string | null }> = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  const resolver = new QueueInAppNotificationTargetResolver({
    query,
  } as unknown as Pool);
  return { resolver, query };
}

describe('QueueInAppNotificationTargetResolver', () => {
  it('derives the exact in-app visit-patient target from clinic and queue entry', async () => {
    const { resolver, query } = fixture([{ patient_id: 'patient-1' }]);

    await expect(resolver.resolveTarget(intent())).resolves.toEqual({
      subjectKind: 'visit_patient',
      subjectId: 'patient-1',
      channel: 'in_app',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id=$1 AND clinic_id=$2'),
      ['entry-1', 'clinic-1'],
    );
  });

  it('fails closed before querying when queue identity is absent or inconsistent', async () => {
    const { resolver, query } = fixture([{ patient_id: 'patient-1' }]);

    await expect(
      resolver.resolveTarget(intent({ queueEntryId: null })),
    ).resolves.toBeNull();
    await expect(
      resolver.resolveTarget(intent({ logicalTargetKey: 'queue-entry:other' })),
    ).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when the clinic-scoped queue row is missing or has no patient', async () => {
    const missing = fixture();
    await expect(missing.resolver.resolveTarget(intent())).resolves.toBeNull();

    const noPatient = fixture([{ patient_id: null }]);
    await expect(noPatient.resolver.resolveTarget(intent())).resolves.toBeNull();
  });
});
