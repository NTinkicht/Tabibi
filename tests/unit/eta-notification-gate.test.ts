import { describe, expect, it, vi } from 'vitest';
import {
  EtaNotificationGate,
  decideEtaNotification,
  etaNotificationDedupKey,
  type EtaNotificationSnapshot,
} from '@/modules/notification-domain/eta-notification-gate';
import {
  QueueNotificationProducer,
  type QueueNotificationIntentStore,
} from '@/modules/notification-domain/queue-notification-producer';

const base: EtaNotificationSnapshot = {
  queueEntryId: 'entry-1',
  revision: 1,
  estimatorVersion: 'eta/v1',
  sessionEpoch: 3,
  priorEpoch: 1,
  minWaitMinutes: 20,
  maxWaitMinutes: 40,
  queuePosition: 5,
};
const cur = { sessionEpoch: 3, priorEpoch: 1 };
const next = (
  o: Partial<EtaNotificationSnapshot>,
): EtaNotificationSnapshot => ({
  ...base,
  revision: 2,
  ...o,
});

describe('decideEtaNotification', () => {
  it('notifies at exactly the 10 minute midpoint threshold, not just under', () => {
    const at = decideEtaNotification(
      base,
      next({ minWaitMinutes: 30, maxWaitMinutes: 50 }),
      cur,
    );
    expect(at).toEqual({
      notify: true,
      reason: 'material_change',
      dedupKey: 'eta:entry-1:2',
    });
    expect(
      decideEtaNotification(
        base,
        next({ minWaitMinutes: 29, maxWaitMinutes: 49 }),
        cur,
      ),
    ).toEqual({ notify: false, reason: 'not_material' });
  });

  it('notifies at exactly the 15 minute uncertainty threshold, not just under', () => {
    // midpoint unchanged (30), width 20 -> 35 (delta 15) vs 34 (delta 14)
    expect(
      decideEtaNotification(
        base,
        next({ minWaitMinutes: 12.5, maxWaitMinutes: 47.5 }),
        cur,
      ).notify,
    ).toBe(true);
    expect(
      decideEtaNotification(
        base,
        next({ minWaitMinutes: 13, maxWaitMinutes: 47 }),
        cur,
      ),
    ).toEqual({ notify: false, reason: 'not_material' });
  });

  it('notifies at exactly 2 queue positions, not 1', () => {
    expect(
      decideEtaNotification(base, next({ queuePosition: 3 }), cur).notify,
    ).toBe(true);
    expect(
      decideEtaNotification(base, next({ queuePosition: 4 }), cur),
    ).toEqual({
      notify: false,
      reason: 'not_material',
    });
  });

  it('fails closed on stale, equal, version, epoch, entry and baseline problems', () => {
    const big = { minWaitMinutes: 60, maxWaitMinutes: 80 };
    expect(
      decideEtaNotification(base, next({ ...big, revision: 1 }), cur),
    ).toEqual({
      notify: false,
      reason: 'duplicate_revision',
    });
    expect(
      decideEtaNotification(
        { ...base, revision: 5 },
        next({ ...big, revision: 4 }),
        cur,
      ),
    ).toEqual({ notify: false, reason: 'stale_revision' });
    expect(
      decideEtaNotification(
        base,
        next({ ...big, estimatorVersion: 'eta/v2' }),
        cur,
      ),
    ).toEqual({ notify: false, reason: 'estimator_version_mismatch' });
    expect(
      decideEtaNotification(base, next({ ...big, sessionEpoch: 4 }), cur),
    ).toEqual({ notify: false, reason: 'source_epoch_mismatch' });
    expect(
      decideEtaNotification(base, next({ ...big, priorEpoch: 2 }), cur),
    ).toEqual({ notify: false, reason: 'source_epoch_mismatch' });
    expect(
      decideEtaNotification(
        base,
        next({ ...big, queueEntryId: 'entry-2' }),
        cur,
      ),
    ).toEqual({ notify: false, reason: 'entry_mismatch' });
    expect(decideEtaNotification(null, next(big), cur)).toEqual({
      notify: false,
      reason: 'no_baseline',
    });
    expect(
      decideEtaNotification(base, next({ ...big, revision: 0 }), cur),
    ).toEqual({
      notify: false,
      reason: 'invalid_snapshot',
    });
    expect(
      decideEtaNotification(
        base,
        next({ minWaitMinutes: 50, maxWaitMinutes: 10 }),
        cur,
      ),
    ).toEqual({ notify: false, reason: 'invalid_snapshot' });
    expect(
      decideEtaNotification({ ...base, estimatorVersion: ' ' }, next(big), cur),
    ).toEqual({ notify: false, reason: 'invalid_snapshot' });
  });

  it('notifies when epochs advanced since the baseline but the latest snapshot is current', () => {
    const advanced = { sessionEpoch: 9, priorEpoch: 4 };
    const latest = next({ queuePosition: 3, ...advanced });
    expect(decideEtaNotification(base, latest, advanced).notify).toBe(true);
    expect(decideEtaNotification(base, latest, cur)).toEqual({
      notify: false,
      reason: 'source_epoch_mismatch',
    });
  });

  it('builds a deterministic key that fits the producer source-event bound', () => {
    expect(etaNotificationDedupKey(' entry-1 ', 7)).toBe('eta:entry-1:7');
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(
      etaNotificationDedupKey(uuid, Number.MAX_SAFE_INTEGER).length,
    ).toBeLessThanOrEqual(96);
  });
});

describe('EtaNotificationGate', () => {
  it('enqueues one bounded intent without identity beyond ids, and none when not material', async () => {
    const enqueue = vi.fn<QueueNotificationIntentStore['enqueue']>(
      async () => ({ id: 'i' }) as never,
    );
    const gate = new EtaNotificationGate(
      new QueueNotificationProducer({ enqueue }),
    );

    await expect(
      gate.submit({
        clinicId: 'c1',
        lastDelivered: base,
        latest: next({ queuePosition: 3 }),
        currentEpochs: cur,
        locale: 'fr',
      }),
    ).resolves.toMatchObject({ enqueued: true });
    expect(enqueue).toHaveBeenCalledWith({
      clinicId: 'c1',
      queueEntryId: 'entry-1',
      logicalTargetKey: 'queue-entry:entry-1',
      eventKey: 'estimate_changed_materially',
      intentVersion: 2,
      idempotencyKey: 'queue-event:eta:entry-1:2',
      payload: { locale: 'fr', windowStartMinutes: 20, windowEndMinutes: 40 },
    });

    enqueue.mockClear();
    await expect(
      gate.submit({
        clinicId: 'c1',
        lastDelivered: base,
        latest: next({ sessionEpoch: 9, queuePosition: 1 }),
        currentEpochs: cur,
      }),
    ).resolves.toEqual({ enqueued: false, reason: 'source_epoch_mismatch' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
