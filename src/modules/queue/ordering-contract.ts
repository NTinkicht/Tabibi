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

export type QueueOrderingSessionStatus =
  | 'planned'
  | 'open'
  | 'paused'
  | 'closed'
  | 'cancelled';

export type QueueOrderingEntryState =
  | 'waiting'
  | 'checked_in'
  | 'called'
  | 'in_consultation'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export interface QueueOrderingEntry {
  readonly id: string;
  readonly state: QueueOrderingEntryState;
  readonly priorityOrder: number | null;
  readonly eligibilityOrder: number | null;
  readonly registrationOrder: number;
}

export type QueueOrderingRejectionReason =
  | 'unsupported_contract_version'
  | 'invalid_ordering_value'
  | 'duplicate_entry_id'
  | 'duplicate_registration_order'
  | 'missing_eligibility_order'
  | 'duplicate_eligibility_order'
  | 'duplicate_priority_order';

export class QueueOrderingError extends Error {
  constructor(readonly reason: QueueOrderingRejectionReason) {
    super(`queue ordering rejected: ${reason}`);
    this.name = 'QueueOrderingError';
  }
}

/** Call-eligible only when the entry is `checked_in` and the session `open`. */
export function isCallEligible(
  sessionStatus: QueueOrderingSessionStatus,
  state: QueueOrderingEntryState,
): boolean {
  return sessionStatus === 'open' && state === 'checked_in';
}

/**
 * Canonical tuple: priority bucket, priority_order, eligibility_order, then
 * immutable registration_order. Callers must pass validated eligible entries.
 */
export function compareQueueOrdering(
  a: QueueOrderingEntry,
  b: QueueOrderingEntry,
): number {
  const aBucket = a.priorityOrder === null ? 1 : 0;
  const bBucket = b.priorityOrder === null ? 1 : 0;
  if (aBucket !== bBucket) return aBucket - bBucket;
  if (a.priorityOrder !== null && b.priorityOrder !== null) {
    if (a.priorityOrder !== b.priorityOrder) {
      return a.priorityOrder - b.priorityOrder;
    }
  }
  const aEligibility = a.eligibilityOrder as number;
  const bEligibility = b.eligibilityOrder as number;
  if (aEligibility !== bEligibility) return aEligibility - bEligibility;
  return a.registrationOrder - b.registrationOrder;
}

function validOrder(value: number | null, allowNull: boolean): boolean {
  if (value === null) return allowNull;
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Returns the ids of call-eligible entries in canonical service order. The
 * result is independent of input order. Malformed or ambiguous input fails
 * closed with a QueueOrderingError instead of inventing ordering semantics.
 */
export function orderCallableEntries(
  contractVersion: string,
  sessionStatus: QueueOrderingSessionStatus,
  entries: readonly QueueOrderingEntry[],
): readonly string[] {
  if (contractVersion !== QUEUE_ORDERING_CONTRACT_VERSION) {
    throw new QueueOrderingError('unsupported_contract_version');
  }
  const ids = new Set<string>();
  const registrations = new Set<number>();
  for (const entry of entries) {
    if (
      !validOrder(entry.registrationOrder, false) ||
      !validOrder(entry.eligibilityOrder, true) ||
      !validOrder(entry.priorityOrder, true)
    ) {
      throw new QueueOrderingError('invalid_ordering_value');
    }
    if (ids.has(entry.id)) throw new QueueOrderingError('duplicate_entry_id');
    ids.add(entry.id);
    if (registrations.has(entry.registrationOrder)) {
      throw new QueueOrderingError('duplicate_registration_order');
    }
    registrations.add(entry.registrationOrder);
  }
  const eligible = entries.filter((entry) =>
    isCallEligible(sessionStatus, entry.state),
  );
  const eligibility = new Set<number>();
  const priorities = new Set<number>();
  for (const entry of eligible) {
    if (entry.eligibilityOrder === null) {
      throw new QueueOrderingError('missing_eligibility_order');
    }
    if (eligibility.has(entry.eligibilityOrder)) {
      throw new QueueOrderingError('duplicate_eligibility_order');
    }
    eligibility.add(entry.eligibilityOrder);
    if (entry.priorityOrder !== null) {
      if (priorities.has(entry.priorityOrder)) {
        throw new QueueOrderingError('duplicate_priority_order');
      }
      priorities.add(entry.priorityOrder);
    }
  }
  return [...eligible].sort(compareQueueOrdering).map((entry) => entry.id);
}
