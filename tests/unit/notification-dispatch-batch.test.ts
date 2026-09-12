import { describe, expect, it, vi } from 'vitest';
import {
  NotificationDispatchBatchRunner,
  type NotificationDispatchEligibilityStore,
  type NotificationDispatchExecutor,
} from '@/modules/notification-domain/dispatch-batch';
import { recordNotificationDispatchEvent } from '@/modules/notification-domain/observability';

function candidate(intentId: string, eligibleAt = '2026-09-11T00:00:00.000Z') {
  return { intentId, eligibleAt };
}

describe('NotificationDispatchBatchRunner', () => {
  it('continues the batch when per-item and aggregate observers throw', async () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const observer = {
      record: () => {
        throw new Error('Sensitive telemetry');
      },
    };
    const intentIds: string[] = [];
    const dispatchOne = vi.fn(async ({ clinicId, intentId }) => {
      intentIds.push(intentId);
      recordNotificationDispatchEvent(observer, {
        name: 'notification.dispatch.not_claimed',
        clinicId,
        intentId,
      });
      return { status: 'not_claimed' } as const;
    });
    const runner = new NotificationDispatchBatchRunner(
      {
        listEligible: vi.fn(async () => [
          candidate('intent-1'),
          candidate('intent-2'),
        ]),
      },
      { dispatchOne },
      observer,
    );

    await expect(
      runner.run({ clinicId: 'clinic-1', limit: 2 }),
    ).resolves.toEqual({
      selected: 2,
      completed: 0,
      suppressed: 0,
      notClaimed: 2,
      claimLost: 0,
    });
    expect(intentIds).toEqual(['intent-1', 'intent-2']);
    expect(error).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      'Sensitive telemetry',
    );
    error.mockRestore();
  });

  it('executes selected intents in scanner order and returns aggregate-only counts', async () => {
    const record = vi.fn();
    const listEligible = vi.fn(async () => [
      candidate('intent-1'),
      candidate('intent-2'),
      candidate('intent-3'),
      candidate('intent-4'),
    ]);
    const dispatchOne = vi
      .fn<NotificationDispatchExecutor['dispatchOne']>()
      .mockResolvedValueOnce({ status: 'completed' } as never)
      .mockResolvedValueOnce({ status: 'suppressed' } as never)
      .mockResolvedValueOnce({ status: 'not_claimed' })
      .mockResolvedValueOnce({
        status: 'claim_lost',
        claimToken: 'claim-4',
        providerIdempotencyKey: 'notification:intent-4',
        providerResult: { kind: 'unknown' },
      });

    const runner = new NotificationDispatchBatchRunner(
      { listEligible } satisfies NotificationDispatchEligibilityStore,
      { dispatchOne } satisfies NotificationDispatchExecutor,
      { record },
    );

    const summary = await runner.run({ clinicId: ' clinic-1 ', limit: 4 });
    expect(summary).toEqual({
      selected: 4,
      completed: 1,
      suppressed: 1,
      notClaimed: 1,
      claimLost: 1,
    });
    expect(listEligible).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      limit: 4,
    });
    expect(dispatchOne.mock.calls.map(([input]) => input.intentId)).toEqual([
      'intent-1',
      'intent-2',
      'intent-3',
      'intent-4',
    ]);
    expect(JSON.stringify(summary)).not.toContain('providerResult');
    expect(record).toHaveBeenCalledWith({
      name: 'notification.dispatch.batch',
      clinicId: 'clinic-1',
      selected: 4,
      completed: 1,
      suppressed: 1,
      notClaimed: 1,
      claimLost: 1,
    });
  });

  it('returns an empty deterministic summary when no intent is eligible', async () => {
    const record = vi.fn();
    const listEligible = vi.fn(async () => []);
    const dispatchOne = vi.fn<NotificationDispatchExecutor['dispatchOne']>();
    const runner = new NotificationDispatchBatchRunner(
      { listEligible },
      { dispatchOne },
      { record },
    );

    await expect(
      runner.run({ clinicId: 'clinic-1', limit: 10 }),
    ).resolves.toEqual({
      selected: 0,
      completed: 0,
      suppressed: 0,
      notClaimed: 0,
      claimLost: 0,
    });
    expect(dispatchOne).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      name: 'notification.dispatch.batch',
      clinicId: 'clinic-1',
      selected: 0,
      completed: 0,
      suppressed: 0,
      notClaimed: 0,
      claimLost: 0,
    });
  });
});
