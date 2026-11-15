import { PushSubscriptionSealer } from './subscription-seal';

/** Thrown when the runtime seal secret is absent, so routes fail closed. */
export class GuestPushNotConfiguredError extends Error {
  constructor() {
    super('Guest push subscription sealing is not configured');
    this.name = 'GuestPushNotConfiguredError';
  }
}

/**
 * The sealing key comes only from runtime configuration (never the database
 * or Git). Without it no subscription is stored: the routes answer 503.
 */
export function guestPushSealer(): PushSubscriptionSealer {
  const secret = process.env.GUEST_PUSH_SEAL_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new GuestPushNotConfiguredError();
  }
  return new PushSubscriptionSealer(secret);
}
