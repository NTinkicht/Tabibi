import { describe, expect, it } from 'vitest';
import type { EtaNotificationBaselineStore } from '@/modules/notification-domain/eta-notification-baseline';
import { EtaNotificationCoordinator } from '@/modules/notification-domain/eta-notification-coordinator';
import {
  EtaNotificationGate,
  type EtaNotificationSnapshot,
} from '@/modules/notification-domain/eta-notification-gate';
import { QueueNotificationProducer } from '@/modules/notification-domain/queue-notification-producer';

const snap = (
  o: Partial<EtaNotificationSnapshot>,
): EtaNotificationSnapshot => ({
  queueEntryId: 'e1',
  revision: 1,
  estimatorVersion: 'eta/v1',
  sessionEpoch: 3,
  priorEpoch: 1,
  minWaitMinutes: 20,
  maxWaitMinutes: 40,
  queuePosition: 5,
  ...o,
});
const cur = { sessionEpoch: 3, priorEpoch: 1 };

function memoryStore(): EtaNotificationBaselineStore & {
  rows: Map<string, EtaNotificationSnapshot>;
} {
  const rows = new Map<string, EtaNotificationSnapshot>();
  return {
    rows,
    async load(_c, id) {
      return rows.get(id) ?? null;
    },
    async recordInitial(_c, s) {
      if (rows.has(s.queueEntryId)) return false;
      rows.set(s.queueEntryId, s);
      return true;
    },
    async advance(_c, s) {
      const e = rows.get(s.queueEntryId);
      if (!e || e.revision >= s.revision) return false;
      rows.set(s.queueEntryId, s);
      return true;
    },
  };
}

function setup() {
  const enqueued: unknown[] = [];
  const producer = new QueueNotificationProducer({
    enqueue: async (i) => {
      enqueued.push(i);
      return { id: 'i' } as never;
    },
  });
  const baselines = memoryStore();
  return {
    enqueued,
    baselines,
    c: new EtaNotificationCoordinator(
      new EtaNotificationGate(producer),
      baselines,
    ),
  };
}

describe('EtaNotificationCoordinator', () => {
  it('records the first snapshot as baseline without notifying', async () => {
    const { c, enqueued, baselines } = setup();
    expect(
      await c.process({ clinicId: 'c', latest: snap({}), currentEpochs: cur }),
    ).toEqual({
      status: 'baseline_recorded',
    });
    expect(enqueued).toHaveLength(0);
    expect(baselines.rows.get('e1')?.revision).toBe(1);
  });

  it('never persists an invalid first snapshot', async () => {
    const { c, baselines } = setup();
    const r = await c.process({
      clinicId: 'c',
      latest: snap({ queuePosition: 0 }),
      currentEpochs: cur,
    });
    expect(r).toEqual({ enqueued: false, reason: 'invalid_snapshot' });
    expect(baselines.rows.size).toBe(0);
  });

  it('enqueues on a material change and advances the baseline', async () => {
    const { c, enqueued, baselines } = setup();
    await c.process({ clinicId: 'c', latest: snap({}), currentEpochs: cur });
    const r = await c.process({
      clinicId: 'c',
      latest: snap({ revision: 2, minWaitMinutes: 30, maxWaitMinutes: 50 }),
      currentEpochs: cur,
    });
    expect(r).toEqual({ status: 'enqueued', baselineAdvanced: true });
    expect(enqueued).toHaveLength(1);
    expect(baselines.rows.get('e1')?.revision).toBe(2);
  });

  it('keeps the baseline and does not enqueue for a non-material or stale change', async () => {
    const { c, enqueued, baselines } = setup();
    await c.process({
      clinicId: 'c',
      latest: snap({ revision: 5 }),
      currentEpochs: cur,
    });
    const small = await c.process({
      clinicId: 'c',
      latest: snap({ revision: 6, minWaitMinutes: 21, maxWaitMinutes: 41 }),
      currentEpochs: cur,
    });
    const stale = await c.process({
      clinicId: 'c',
      latest: snap({ revision: 4, minWaitMinutes: 90, maxWaitMinutes: 110 }),
      currentEpochs: cur,
    });
    expect(small).toEqual({ enqueued: false, reason: 'not_material' });
    expect(stale).toEqual({ enqueued: false, reason: 'stale_revision' });
    expect(enqueued).toHaveLength(0);
    expect(baselines.rows.get('e1')?.revision).toBe(5);
  });

  it('does not enqueue or advance when source epochs are not current', async () => {
    const { c, enqueued, baselines } = setup();
    await c.process({ clinicId: 'c', latest: snap({}), currentEpochs: cur });
    const r = await c.process({
      clinicId: 'c',
      latest: snap({ revision: 2, minWaitMinutes: 60, maxWaitMinutes: 80 }),
      currentEpochs: { sessionEpoch: 4, priorEpoch: 1 },
    });
    expect(r).toEqual({ enqueued: false, reason: 'source_epoch_mismatch' });
    expect(enqueued).toHaveLength(0);
    expect(baselines.rows.get('e1')?.revision).toBe(1);
  });
});
