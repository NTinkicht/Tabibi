import { describe, expect, it } from 'vitest';
import {
  QUEUE_ORDERING_CONTRACT_VERSION,
  queueOrderingAuditMetadata,
} from '@/modules/queue/ordering-contract';

describe('queue ordering contract metadata', () => {
  it('binds call selection to the exact versioned ordering contract', () => {
    expect(QUEUE_ORDERING_CONTRACT_VERSION).toBe('queue-ordering/v1');
    expect(queueOrderingAuditMetadata('call')).toEqual({
      queueOrderingContractVersion: 'queue-ordering/v1',
    });
  });

  it('does not claim the ordering oracle for unrelated lifecycle commands', () => {
    for (const command of [
      'check_in',
      'no_show',
      'cancel',
      'start_consultation',
      'complete_consultation',
    ]) {
      expect(queueOrderingAuditMetadata(command)).toEqual({});
    }
  });
});
