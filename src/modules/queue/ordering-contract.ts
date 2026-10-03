export const QUEUE_ORDERING_CONTRACT_VERSION = 'queue-ordering/v1' as const;

export type QueueOrderingAuditMetadata = Readonly<{
  queueOrderingContractVersion: typeof QUEUE_ORDERING_CONTRACT_VERSION;
}>;

/**
 * Returns the audit metadata that binds an ordering-dependent queue action to
 * the exact deterministic service-order contract used to select its winner.
 *
 * Only `call` consumes the queue-ordering oracle directly. Other lifecycle
 * commands must not claim an ordering contract they did not evaluate.
 */
export function queueOrderingAuditMetadata(
  command: string,
): QueueOrderingAuditMetadata | Readonly<Record<string, never>> {
  if (command !== 'call') return {};
  return { queueOrderingContractVersion: QUEUE_ORDERING_CONTRACT_VERSION };
}
