import type { Pool } from 'pg';
import type {
  GuestLinkIntentStore,
  LinkSender,
} from '@/modules/guest-access/link-intents';
import type { NotificationDispatchBatchSummary } from '@/modules/notification-domain/dispatch-batch';

export const WORKER_OUTBOX_BATCH_LIMIT = 50;
export const WORKER_LINK_SEND_LIMIT = 50;
const MAX_CLINICS_PER_TICK = 200;

export interface OutboxBatchRunner {
  run(input: {
    clinicId: string;
    limit: number;
  }): Promise<NotificationDispatchBatchSummary>;
}

/** Counts only: never ids of patients, entries, subscriptions or exchanges. */
export interface DispatchTickCounts {
  clinics: number;
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  suppressed: number;
  errors: number;
  scrubbed: number;
}

export interface DispatchTickDeps {
  pool: Pool;
  outboxRunner: OutboxBatchRunner;
  linkStore: Pick<GuestLinkIntentStore, 'dispatchNext' | 'scrubExpired'>;
  /** Per-channel registry entry. Absent: link intents stay pending and expire. */
  linkSender?: LinkSender;
}

/** Clinics that currently have outbox intents the claim fence may accept. */
export async function listClinicsWithDueIntents(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ clinic_id: string }>(
    `SELECT DISTINCT clinic_id
       FROM notification_outbox
      WHERE state IN ('pending', 'failed', 'unknown')
        AND superseded_by_id IS NULL
        AND dispatch_attempt_count < dispatch_max_attempts
        AND (state = 'pending'
             OR next_attempt_at <= now()
             OR (dispatch_claim_token IS NOT NULL
                 AND dispatch_claim_expires_at <= now()))
        AND (dispatch_claim_token IS NULL
             OR dispatch_claim_expires_at <= now())
      ORDER BY clinic_id
      LIMIT $1`,
    [MAX_CLINICS_PER_TICK],
  );
  return result.rows.map((row) => row.clinic_id);
}

/** One scheduler tick. Claims, leases and fences live in the called components. */
export async function runDispatchTick(
  deps: DispatchTickDeps,
): Promise<DispatchTickCounts> {
  const counts: DispatchTickCounts = {
    clinics: 0,
    claimed: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    suppressed: 0,
    errors: 0,
    scrubbed: 0,
  };

  // 1. Outbox batches per clinic with due intents.
  for (const clinicId of await listClinicsWithDueIntents(deps.pool)) {
    counts.clinics += 1;
    try {
      const summary = await deps.outboxRunner.run({
        clinicId,
        limit: WORKER_OUTBOX_BATCH_LIMIT,
      });
      counts.claimed += summary.completed + summary.suppressed;
      counts.delivered += summary.completed;
      counts.suppressed += summary.suppressed;
      counts.errors += summary.errors;
    } catch {
      counts.errors += 1;
    }
  }

  // 2. Guest-link intents, only when a sender is registered.
  if (deps.linkSender) {
    for (let sent = 0; sent < WORKER_LINK_SEND_LIMIT; sent += 1) {
      let outcome;
      try {
        outcome = await deps.linkStore.dispatchNext(deps.linkSender);
      } catch {
        counts.errors += 1;
        break;
      }
      if (outcome === 'none') break;
      counts.claimed += 1;
      if (outcome === 'delivered') counts.delivered += 1;
      else if (outcome === 'retry_scheduled') counts.retried += 1;
      else counts.deadLettered += 1;
    }
  }

  // 3. Expire and scrub.
  try {
    counts.scrubbed = await deps.linkStore.scrubExpired();
  } catch {
    counts.errors += 1;
  }
  return counts;
}

export function dispatchIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 15_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 3_600_000) {
    throw new Error(
      'NOTIFICATION_DISPATCH_INTERVAL_MS must be between 1000 and 3600000',
    );
  }
  return value;
}
