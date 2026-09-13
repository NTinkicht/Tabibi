import type {
  EnqueueNotificationIntentInput,
  NotificationIntent,
} from '@/modules/notification-outbox';

const LOGICAL_TARGET_PREFIX = 'queue-entry:';
const MAX_LOGICAL_TARGET_KEY_LENGTH = 160;
const MAX_QUEUE_ENTRY_ID_LENGTH =
  MAX_LOGICAL_TARGET_KEY_LENGTH - LOGICAL_TARGET_PREFIX.length;

export type SupportedQueueNotificationEvent =
  | {
      eventKey: 'queue_entry_created';
      locale?: string | null;
    }
  | {
      eventKey: 'estimate_changed_materially';
      locale?: string | null;
      windowStartMinutes: number;
      windowEndMinutes: number;
    }
  | {
      eventKey: 'turn_approaching';
      locale?: string | null;
      position: number;
    }
  | {
      eventKey: 'patient_called';
      locale?: string | null;
    }
  | {
      eventKey: 'queue_entry_cancelled';
      locale?: string | null;
    };

export interface QueueNotificationSourceEvent {
  clinicId: string;
  queueEntryId: string;
  sourceEventId: string;
  sourceVersion: number;
  notification: SupportedQueueNotificationEvent;
}

export interface QueueNotificationIntentStore {
  enqueue(input: EnqueueNotificationIntentInput): Promise<NotificationIntent>;
}

export class QueueNotificationProducerValidationError extends Error {}

function requiredId(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new QueueNotificationProducerValidationError(
      `${label} is required and must be at most ${maxLength} characters`,
    );
  }
  return normalized;
}

function localePayload(locale: string | null | undefined) {
  const normalized = locale?.trim();
  return normalized ? { locale: normalized } : {};
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new QueueNotificationProducerValidationError(
      `${label} must be a finite non-negative number`,
    );
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new QueueNotificationProducerValidationError(
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function payloadFor(
  notification: SupportedQueueNotificationEvent,
): Record<string, unknown> {
  const common = localePayload(notification.locale);
  switch (notification.eventKey) {
    case 'queue_entry_created':
    case 'patient_called':
    case 'queue_entry_cancelled':
      return common;
    case 'estimate_changed_materially': {
      const windowStartMinutes = finiteNonNegative(
        notification.windowStartMinutes,
        'Window start minutes',
      );
      const windowEndMinutes = finiteNonNegative(
        notification.windowEndMinutes,
        'Window end minutes',
      );
      if (windowEndMinutes < windowStartMinutes) {
        throw new QueueNotificationProducerValidationError(
          'Window end minutes must not precede window start minutes',
        );
      }
      return { ...common, windowStartMinutes, windowEndMinutes };
    }
    case 'turn_approaching':
      return {
        ...common,
        position: positiveSafeInteger(notification.position, 'Queue position'),
      };
    default:
      throw new QueueNotificationProducerValidationError(
        'Unsupported queue notification event',
      );
  }
}

/**
 * Converts already-authoritative queue lifecycle events into durable notification
 * intents. It owns no delivery destination, consent lookup, rendering or provider
 * behavior; those remain downstream boundaries.
 */
export class QueueNotificationProducer {
  constructor(private readonly store: QueueNotificationIntentStore) {}

  async produce(raw: QueueNotificationSourceEvent): Promise<NotificationIntent> {
    const clinicId = requiredId(raw.clinicId, 'Clinic id', 160);
    const queueEntryId = requiredId(
      raw.queueEntryId,
      'Queue entry id',
      MAX_QUEUE_ENTRY_ID_LENGTH,
    );
    const sourceEventId = requiredId(raw.sourceEventId, 'Source event id', 96);
    const sourceVersion = positiveSafeInteger(
      raw.sourceVersion,
      'Source version',
    );

    return this.store.enqueue({
      clinicId,
      queueEntryId,
      logicalTargetKey: `${LOGICAL_TARGET_PREFIX}${queueEntryId}`,
      eventKey: raw.notification.eventKey,
      intentVersion: sourceVersion,
      idempotencyKey: `queue-event:${sourceEventId}`,
      payload: payloadFor(raw.notification),
    });
  }
}
