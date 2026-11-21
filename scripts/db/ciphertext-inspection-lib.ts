import type { Pool } from 'pg';

/**
 * Release-time, read-only inspection of notification and replay ciphertext at
 * rest (TAB-P0-15). The report only carries counts: ciphertext, plaintext
 * material and identifiers are never selected into the result.
 */
export interface CiphertextInspectionReport {
  inspectedAt: string;
  guestLinkIntents: {
    pendingWithCiphertext: number;
    /** Pending rows whose ciphertext outlived its expiry (scrub overdue). */
    pendingPastExpiry: number;
    /** Terminal rows still holding ciphertext (must be impossible). */
    terminalWithCiphertext: number;
    /** Stored value is not an AAD-bound `gle1` envelope (plaintext suspect). */
    malformedCiphertext: number;
  };
  bookingReceipts: {
    withCiphertext: number;
    /** Ciphertext still stored although the linked credential is dead. */
    unscrubbedAfterCredentialDead: number;
    /** Stored value is not a `v1` AES-GCM envelope (plaintext suspect). */
    malformedCiphertext: number;
  };
  clean: boolean;
}

const INTENT_ENVELOPE =
  '^gle1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$';
const RECEIPT_ENVELOPE =
  '^v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$';

export async function inspectCiphertextAtRest(
  pool: Pick<Pool, 'query'>,
  now: Date,
): Promise<CiphertextInspectionReport> {
  const intents = await pool.query<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE envelope_ciphertext IS NOT NULL AND state = 'pending') AS pending_with_ciphertext,
       count(*) FILTER (WHERE envelope_ciphertext IS NOT NULL AND state = 'pending' AND expires_at <= $1) AS pending_past_expiry,
       count(*) FILTER (WHERE envelope_ciphertext IS NOT NULL AND state <> 'pending') AS terminal_with_ciphertext,
       count(*) FILTER (WHERE envelope_ciphertext IS NOT NULL AND envelope_ciphertext !~ $2) AS malformed
     FROM guest_link_intents`,
    [now, INTENT_ENVELOPE],
  );
  const receipts = await pool.query<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE receipt.access_ciphertext IS NOT NULL) AS with_ciphertext,
       count(*) FILTER (WHERE receipt.access_ciphertext IS NOT NULL
         AND (credential.expires_at <= $1 OR credential.revoked_at IS NOT NULL)) AS unscrubbed_dead,
       count(*) FILTER (WHERE receipt.access_ciphertext IS NOT NULL
         AND receipt.access_ciphertext !~ $2) AS malformed
     FROM public_guest_booking_receipts receipt
     LEFT JOIN guest_credentials credential
       ON credential.id = receipt.credential_id
      AND credential.clinic_id = receipt.clinic_id`,
    [now, RECEIPT_ENVELOPE],
  );
  const i = intents.rows[0] ?? {};
  const r = receipts.rows[0] ?? {};
  const guestLinkIntents = {
    pendingWithCiphertext: Number(i.pending_with_ciphertext ?? 0),
    pendingPastExpiry: Number(i.pending_past_expiry ?? 0),
    terminalWithCiphertext: Number(i.terminal_with_ciphertext ?? 0),
    malformedCiphertext: Number(i.malformed ?? 0),
  };
  const bookingReceipts = {
    withCiphertext: Number(r.with_ciphertext ?? 0),
    unscrubbedAfterCredentialDead: Number(r.unscrubbed_dead ?? 0),
    malformedCiphertext: Number(r.malformed ?? 0),
  };
  return {
    inspectedAt: now.toISOString(),
    guestLinkIntents,
    bookingReceipts,
    clean:
      guestLinkIntents.pendingPastExpiry === 0 &&
      guestLinkIntents.terminalWithCiphertext === 0 &&
      guestLinkIntents.malformedCiphertext === 0 &&
      bookingReceipts.unscrubbedAfterCredentialDead === 0 &&
      bookingReceipts.malformedCiphertext === 0,
  };
}
