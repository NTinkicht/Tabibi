import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * AAD-bound envelope for short-lived guest status-link material (TAB-P0-08).
 *
 * The envelope is the only form in which link material may be persisted in a
 * notification intent. It is authenticated (AES-256-GCM), bound to the intent
 * kind, queue entry and clinic through AAD, and expires no later than the
 * exchange ID it carries. Every failure is fail-closed with one generic error:
 * there is no plaintext fallback and no detail that could leak material.
 */

const VERSION = 'gle1';
const IV_BYTES = 12;
const MIN_SECRET_BYTES = 32;
const KEY_LABEL = 'tabibi/guest-link-envelope/v1';

/** Exchange-ID TTL ceiling; the ciphertext may never outlive it. */
export const EXCHANGE_TTL_MS = 10 * 60 * 1000;

export const GUEST_LINK_INTENT_KINDS = [
  'initial',
  'transfer',
  'resend',
  'recovery',
] as const;
export type GuestLinkIntentKind = (typeof GUEST_LINK_INTENT_KINDS)[number];

export interface GuestLinkBinding {
  intent: GuestLinkIntentKind;
  /** Unique notification intent ID; prevents ciphertext swaps between intents. */
  intentId: string;
  entryId: string;
  clinicId: string;
}

export class GuestLinkEnvelopeError extends Error {
  constructor() {
    super('Guest link envelope rejected');
    this.name = 'GuestLinkEnvelopeError';
  }
}

interface Claims {
  v: 1;
  expiresAt: number;
  material: string;
}

function deriveKey(secret: string): Buffer {
  if (
    typeof secret !== 'string' ||
    Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES
  ) {
    throw new GuestLinkEnvelopeError();
  }
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.alloc(0), KEY_LABEL, 32),
  );
}

function aad(binding: GuestLinkBinding): Buffer {
  if (
    !(GUEST_LINK_INTENT_KINDS as readonly string[]).includes(binding.intent) ||
    typeof binding.intentId !== 'string' ||
    binding.intentId === '' ||
    typeof binding.entryId !== 'string' ||
    binding.entryId === '' ||
    typeof binding.clinicId !== 'string' ||
    binding.clinicId === ''
  ) {
    throw new GuestLinkEnvelopeError();
  }
  return Buffer.from(
    JSON.stringify([
      VERSION,
      binding.intent,
      binding.intentId,
      binding.entryId,
      binding.clinicId,
    ]),
    'utf8',
  );
}

export class GuestLinkEnvelope {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly ttlMs: number = EXCHANGE_TTL_MS,
  ) {
    this.key = deriveKey(secret);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > EXCHANGE_TTL_MS) {
      throw new GuestLinkEnvelopeError();
    }
  }

  seal(
    binding: GuestLinkBinding,
    material: string,
    exchangeExpiresAt: Date,
  ): string {
    if (typeof material !== 'string' || material === '') {
      throw new GuestLinkEnvelopeError();
    }
    const now = this.clock().getTime();
    const exchangeDeadline =
      exchangeExpiresAt instanceof Date ? exchangeExpiresAt.getTime() : NaN;
    if (!Number.isFinite(exchangeDeadline) || exchangeDeadline <= now) {
      throw new GuestLinkEnvelopeError();
    }
    const claims: Claims = {
      v: 1,
      expiresAt: Math.min(now + this.ttlMs, exchangeDeadline),
      material,
    };
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(binding));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(claims), 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  open(binding: GuestLinkBinding, envelope: string): string {
    try {
      const parts = typeof envelope === 'string' ? envelope.split('.') : [];
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new GuestLinkEnvelopeError();
      }
      const iv = Buffer.from(parts[1]!, 'base64url');
      const ciphertext = Buffer.from(parts[2]!, 'base64url');
      const tag = Buffer.from(parts[3]!, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== 16) {
        throw new GuestLinkEnvelopeError();
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(tag);
      const claims = JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
          'utf8',
        ),
      ) as Claims;
      if (
        claims.v !== 1 ||
        typeof claims.material !== 'string' ||
        typeof claims.expiresAt !== 'number' ||
        !Number.isFinite(claims.expiresAt) ||
        claims.expiresAt <= this.clock().getTime()
      ) {
        throw new GuestLinkEnvelopeError();
      }
      return claims.material;
    } catch {
      throw new GuestLinkEnvelopeError();
    }
  }
}
