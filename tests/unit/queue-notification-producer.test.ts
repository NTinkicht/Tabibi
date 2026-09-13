import { describe, expect, it, vi } from 'vitest';
import {
  QueueNotificationProducer,
  QueueNotificationProducerValidationError,
  type QueueNotificationIntentStore,
  type QueueNotificationSourceEvent,
} from '@/modules/notification-domain/queue-notification-producer';

describe('QueueNotificationProducer', () => {
  it('maps a supported event to one bounded canonical outbox intent using position', async () => {
    const storedIntent = { id: 'intent-1' } as never;
    const enqueue = vi.fn(async () => storedIntent);
    const producer = new QueueNotificationProducer({
      enqueue,
    } satisfies QueueNotificationIntentStore);

    await expect(
      producer.produce({
        clinicId: ' clinic-1 ',
        queueEntryId: ' queue-1 ',
        sourceEventId: ' event-9 ',
        sourceVersion: 4,
        notification: {
          eventKey: 'turn_approaching',
          locale: ' fr ',
          position: 2,
        },
      }),
    ).resolves.toBe(storedIntent);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      queueEntryId: 'queue-1',
      logicalTargetKey: 'queue-entry:queue-1',
      eventKey: 'turn_approaching',
      intentVersion: 4,
      idempotencyKey: 'queue-event:event-9',
      payload: { locale: 'fr', position: 2 },
    });
    expect(JSON.stringify(enqueue.mock.calls[0]?.[0])).not.toContain('places');
  });

  it('fails closed before enqueue for guest transfer or any unsupported lifecycle event', async () => {
    const enqueue = vi.fn();
    const producer = new QueueNotificationProducer({
      enqueue,
    } as QueueNotificationIntentStore);

    const unsupported = {
      clinicId: 'clinic-1',
      queueEntryId: 'queue-1',
      sourceEventId: 'event-transfer-1',
      sourceVersion: 5,
      notification: {
        eventKey: 'queue_entry_transferred',
        exchangeLink: 'https://sensitive.invalid/token',
      },
    } as unknown as QueueNotificationSourceEvent;

    await expect(producer.produce(unsupported)).rejects.toBeInstanceOf(
      QueueNotificationProducerValidationError,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects invalid versions and invalid estimate windows before persistence', async () => {
    const enqueue = vi.fn();
    const producer = new QueueNotificationProducer({
      enqueue,
    } as QueueNotificationIntentStore);

    await expect(
      producer.produce({
        clinicId: 'clinic-1',
        queueEntryId: 'queue-1',
        sourceEventId: 'event-1',
        sourceVersion: 0,
        notification: { eventKey: 'queue_entry_created' },
      }),
    ).rejects.toBeInstanceOf(QueueNotificationProducerValidationError);

    await expect(
      producer.produce({
        clinicId: 'clinic-1',
        queueEntryId: 'queue-1',
        sourceEventId: 'event-2',
        sourceVersion: 2,
        notification: {
          eventKey: 'estimate_changed_materially',
          windowStartMinutes: 20,
          windowEndMinutes: 10,
        },
      }),
    ).rejects.toBeInstanceOf(QueueNotificationProducerValidationError);

    expect(enqueue).not.toHaveBeenCalled();
  });
});
