import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  GuestLinkEnvelope,
  GuestLinkEnvelopeError,
  type GuestLinkIntentKind,
} from './link-envelope';

/**
 * Persisted guest-link notification intents (TAB-P0-13 slice, #743).
 *
 * Only the AAD-bound envelope ciphertext is stored. Every terminal outcome
 * (delivered, dead_letter, expired) nulls the ciphertext in the same statement
 * that changes the state, and the table CHECKs make a ciphertext on a terminal
 * row unrepresentable. Provider dispatch is out of scope here.
 */
export type TerminalIntentState = 'delivered' | 'dead_letter';

export interface CreateGuestLinkIntent {
  clinicId: string;
  queueEntryId: string;
  intent: GuestLinkIntentKind;
  /** Plaintext link material; sealed immediately, never stored or logged. */
  material: string;
  exchangeExpiresAt: Date;
}

export type DispatchOutcome =
  | 'none'
  | 'delivered'
  | 'retry_scheduled'
  | 'dead_letter';

export interface DispatchContext {
  intentId: string;
  /** Stable across retries so the provider can deduplicate. */
  idempotencyKey: string;
}

export type LinkSender = (
  material: string,
  context: DispatchContext,
) => Promise<void>;

export interface DispatchOptions {
  leaseMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
}

interface ClaimedRow {
  id: string;
  clinic_id: string;
  queue_entry_id: string;
  intent: GuestLinkIntentKind;
  envelope_ciphertext: string;
  attempts: number;
  expires_at: Date;
}

export class GuestLinkIntentStore {
  constructor(
    private readonly pool: Pool,
    private readonly envelope: GuestLinkEnvelope,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(input: CreateGuestLinkIntent): Promise<string> {
    const id = randomUUID();
    const now = this.clock();
    const ciphertext = this.envelope.seal(
      {
        intent: input.intent,
        intentId: id,
        entryId: input.queueEntryId,
        clinicId: input.clinicId,
      },
      input.material,
      input.exchangeExpiresAt,
    );
    const expiresAt = new Date(
      Math.min(
        input.exchangeExpiresAt.getTime(),
        now.getTime() + 10 * 60 * 1000,
      ),
    );
    await this.pool.query(
      `INSERT INTO guest_link_intents
         (id, clinic_id, queue_entry_id, intent, envelope_ciphertext, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.clinicId,
        input.queueEntryId,
        input.intent,
        ciphertext,
        now,
        expiresAt,
      ],
    );
    return id;
  }

  /** Marks a pending intent terminal and scrubs its ciphertext atomically. */
  async markTerminal(
    clinicId: string,
    intentId: string,
    state: TerminalIntentState,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE guest_link_intents
          SET state = $3, envelope_ciphertext = NULL, scrubbed_at = $4
        WHERE id = $2 AND clinic_id = $1 AND state = 'pending'`,
      [clinicId, intentId, state, this.clock()],
    );
    return result.rowCount === 1;
  }

  /** Expires and scrubs every pending intent past its deadline. */
  async scrubExpired(): Promise<number> {
    const now = this.clock();
    const result = await this.pool.query(
      `UPDATE guest_link_intents
          SET state = 'expired', envelope_ciphertext = NULL, scrubbed_at = $1
        WHERE state = 'pending' AND expires_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Worker step: claim one due, unexpired pending intent under a lease, open
   * its envelope only now, and hand the material to the sender. The sender is
   * never called for expired, tampered or wrong-key intents, which dead-letter
   * without any plaintext fallback.
   */
  async dispatchNext(
    sender: LinkSender,
    options: DispatchOptions = {},
  ): Promise<DispatchOutcome> {
    const leaseMs = options.leaseMs ?? 60_000;
    const maxAttempts = options.maxAttempts ?? 5;
    const backoffMs = options.backoffMs ?? 30_000;
    const now = this.clock();
    const claim = await this.pool.query<ClaimedRow>(
      `UPDATE guest_link_intents
          SET attempts = attempts + 1, claimed_until = $2
        WHERE id = (
          SELECT id FROM guest_link_intents
           WHERE state = 'pending' AND expires_at > $1
             AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
             AND (claimed_until IS NULL OR claimed_until <= $1)
           ORDER BY next_attempt_at NULLS FIRST, created_at
           LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, clinic_id, queue_entry_id, intent,
                  envelope_ciphertext, attempts, expires_at`,
      [now, new Date(now.getTime() + leaseMs)],
    );
    const row = claim.rows[0];
    if (!row) return 'none';
    let material: string;
    try {
      material = this.envelope.open(
        {
          intent: row.intent,
          intentId: row.id,
          entryId: row.queue_entry_id,
          clinicId: row.clinic_id,
        },
        row.envelope_ciphertext,
      );
    } catch (error) {
      if (!(error instanceof GuestLinkEnvelopeError)) throw error;
      await this.markTerminal(row.clinic_id, row.id, 'dead_letter');
      return 'dead_letter';
    }
    try {
      await sender(material, { intentId: row.id, idempotencyKey: row.id });
    } catch {
      const retryAt = new Date(
        this.clock().getTime() + backoffMs * 2 ** (row.attempts - 1),
      );
      if (row.attempts >= maxAttempts || retryAt >= row.expires_at) {
        await this.markTerminal(row.clinic_id, row.id, 'dead_letter');
        return 'dead_letter';
      }
      await this.pool.query(
        `UPDATE guest_link_intents
            SET next_attempt_at = $3, claimed_until = NULL
          WHERE id = $2 AND clinic_id = $1 AND state = 'pending'`,
        [row.clinic_id, row.id, retryAt],
      );
      return 'retry_scheduled';
    }
    await this.markTerminal(row.clinic_id, row.id, 'delivered');
    return 'delivered';
  }
}
