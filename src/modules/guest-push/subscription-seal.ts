import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { validatePushEndpoint } from './endpoint-policy';

/**
 * Sealing for guest push subscriptions (docs/design/pwa-push.md section 3).
 * The envelope is AES-256-GCM with AAD = clinic_id|queue_entry_id|id, and the
 * key comes from runtime configuration, never the database. Lookups use only
 * a keyed HMAC of the endpoint. Every failure is one generic error.
 */
const VERSION = 'gps1';
const IV_BYTES = 12;
const MIN_SECRET_BYTES = 32;
const SEAL_LABEL = 'tabibi/guest-push-subscription/seal/v1';
const HASH_LABEL = 'tabibi/guest-push-subscription/endpoint-hash/v1';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface PushSubscriptionMaterial {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSubscriptionBinding {
  clinicId: string;
  queueEntryId: string;
  id: string;
}

export class PushSubscriptionSealError extends Error {
  constructor() {
    super('Push subscription rejected');
    this.name = 'PushSubscriptionSealError';
  }
}

function derive(secret: string, label: string): Buffer {
  if (
    typeof secret !== 'string' ||
    Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES
  ) {
    throw new PushSubscriptionSealError();
  }
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), label, 32));
}

function aad(binding: PushSubscriptionBinding): Buffer {
  const parts = [binding.clinicId, binding.queueEntryId, binding.id];
  if (parts.some((p) => typeof p !== 'string' || p === '' || p.includes('|'))) {
    throw new PushSubscriptionSealError();
  }
  return Buffer.from(parts.join('|'), 'utf8');
}

function normalise(material: PushSubscriptionMaterial) {
  const keys = material?.keys;
  if (
    !keys ||
    typeof keys.p256dh !== 'string' ||
    typeof keys.auth !== 'string' ||
    !BASE64URL.test(keys.p256dh) ||
    !BASE64URL.test(keys.auth) ||
    keys.p256dh.length > 128 ||
    keys.auth.length > 64
  ) {
    throw new PushSubscriptionSealError();
  }
  return {
    endpoint: validatePushEndpoint(material.endpoint),
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

export class PushSubscriptionSealer {
  private readonly sealKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(secret: string) {
    this.sealKey = derive(secret, SEAL_LABEL);
    this.hashKey = derive(secret, HASH_LABEL);
  }

  /** Keyed lookup hash of the canonical endpoint (64 lowercase hex chars). */
  endpointHash(endpoint: string): string {
    try {
      return createHmac('sha256', this.hashKey)
        .update(validatePushEndpoint(endpoint), 'utf8')
        .digest('hex');
    } catch {
      throw new PushSubscriptionSealError();
    }
  }

  seal(
    binding: PushSubscriptionBinding,
    material: PushSubscriptionMaterial,
  ): string {
    const plaintext = JSON.stringify(normalise(material));
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.sealKey, iv);
    cipher.setAAD(aad(binding));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  open(
    binding: PushSubscriptionBinding,
    envelope: string,
  ): PushSubscriptionMaterial {
    try {
      const parts = typeof envelope === 'string' ? envelope.split('.') : [];
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new PushSubscriptionSealError();
      }
      const iv = Buffer.from(parts[1]!, 'base64url');
      const tag = Buffer.from(parts[3]!, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== 16) {
        throw new PushSubscriptionSealError();
      }
      const decipher = createDecipheriv('aes-256-gcm', this.sealKey, iv);
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parts[2]!, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
      return normalise(JSON.parse(plaintext) as PushSubscriptionMaterial);
    } catch {
      throw new PushSubscriptionSealError();
    }
  }
}
