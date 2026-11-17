import type { Pool } from 'pg';

// TAB-P0-15 data retention (guest side): guest_exchange_ids rows are single-use,
// verifier-only and live at most 10 minutes; terminal guest_link_intents rows
// already had their ciphertext scrubbed. Once long expired neither has a purpose,
// and every reader treats an expired or missing exchange identically (generic
// rejection). Rows are kept for a short grace for support and abuse investigation.
// Pending intents are never touched here: the scrub worker owns their ciphertext.
// guest_credentials are not purged: booking receipts reference them (RESTRICT).
export const GUEST_EXCHANGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PURGE_BATCH = 500;

export interface GuestExchangePurgeResult {
  exchangeIds: number;
  linkIntents: number;
}

/**
 * Deletes at most one bounded batch of each kind per call; rows locked by a
 * concurrent redeem, transfer or scrub are skipped and left for the next run.
 */
export async function purgeExpiredGuestExchangeArtifacts(
  pool: Pool,
  now: Date = new Date(),
): Promise<GuestExchangePurgeResult> {
  const cutoff = new Date(now.getTime() - GUEST_EXCHANGE_RETENTION_MS);
  const exchangeIds = await pool.query(
    `DELETE FROM guest_exchange_ids WHERE id IN (
       SELECT id FROM guest_exchange_ids
        WHERE expires_at <= $1
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  const linkIntents = await pool.query(
    `DELETE FROM guest_link_intents WHERE id IN (
       SELECT id FROM guest_link_intents
        WHERE state <> 'pending' AND expires_at <= $1
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)`,
    [cutoff, PURGE_BATCH],
  );
  return {
    exchangeIds: exchangeIds.rowCount ?? 0,
    linkIntents: linkIntents.rowCount ?? 0,
  };
}
