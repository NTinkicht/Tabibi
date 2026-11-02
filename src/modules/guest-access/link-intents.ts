import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { GuestLinkEnvelope, type GuestLinkIntentKind } from './link-envelope';

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
}
