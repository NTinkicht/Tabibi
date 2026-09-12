import { describe, expect, it, vi } from 'vitest';
import {
  NotificationDispatchBatchRunner,
  type NotificationDispatchEligibilityStore,
  type NotificationDispatchExecutor,
} from '@/modules/notification-domain/dispatch-batch';

function candidate(intentId: string, eligibleAt = '2026-09-11T00:00:00.000Z') {
  return { intentId, eligibleAt };
}

describe('NotificationDispatchBatchRunner', () => {
  it('executes selected intents in scanner order and returns aggregate-only counts', async () => {
    const record = vi.fn();
    const listEligible = vi.fn(async () => [
      candidate('intent-1'),
      candidate('intent-2'),
      candidate('intent-3'),
    ]);
    const dispatchOne = vi
      .fn<NotificationDispatchExecutor['dispatchOne']>()
      .mockResolvedValueOnce({ status: 'completed' } as never)
      .mockResolvedValueOnce({ status: 'not_claimed' })
      .mockResolvedValueOnce({
        status: 'claim_lost',
        claimToken: 'claim-3',
        providerIdempotencyKey: 'notification:intent-3',
        providerResult: { kind: 'unknown' },
      });

    const runner = new NotificationDispatchBatchRunner(
      { listEligible } satisfies NotificationDispatchEligibilityStore,
      { dispatchOne } satisfies NotificationDispatchExecutor,
      { record },
    );

    const summary = await runner.run({ clinicId: ' clinic-1 ', limit: 3 });
    expect(summary).toEqual({
      selected: 3,
      completed: 1,
      notClaimed: 1,
      claimLost: 1,
    });
    expect(listEligible).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      limit: 3,
    });
    expect(dispatchOne.mock.calls.map(([input]) => input.intentId)).toEqual([
      'intent-1',
      'intent-2',
      'intent-3',
    ]);
    expect(JSON.stringify(summary)).not.toContain('providerResult');
    expect(record).toHaveBeenCalledWith({
      name: 'notification.dispatch.batch',
      clinicId: 'clinic-1',
      selected: 3,
      completed: 1,
      notClaimed: 1,
      claimLost: 1,
    });
  });

  it('returns an empty deterministic summary when no intent is eligible', async () => {
    const listEligible = vi.fn(async () => []);
    const dispatchOne = vi.fn<NotificationDispatchExecutor['dispatchOne']>();
    const runner = new NotificationDispatchBatchRunner(
      { listEligible },
      { dispatchOne },
    );

    await expect(
      runner.run({ clinicId: 'clinic-1', limit: 10 }),
    ).resolves.toEqual({
      selected: 0,
      completed: 0,
      notClaimed: 0,
      claimLost: 0,
    });
    expect(dispatchOne).not.toHaveBeenCalled();
  });
});
