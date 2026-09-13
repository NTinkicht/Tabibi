import { describe, expect, it } from 'vitest';
import {
  createQueueInAppNotificationDispatchService,
  QueueInAppNotificationTargetResolver,
} from '@/modules/notification-domain/in-app';

describe('in-app notification public entry point', () => {
  it('exposes the production composition factory and queue target resolver', () => {
    expect(createQueueInAppNotificationDispatchService).toBeTypeOf('function');
    expect(QueueInAppNotificationTargetResolver).toBeTypeOf('function');
  });
});
