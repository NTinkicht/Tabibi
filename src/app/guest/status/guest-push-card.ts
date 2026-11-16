// TAB-PWA-5a (#905, docs/design/pwa-push.md section 5): pure helpers for the
// guest Notifications card. No DOM access here so they stay unit-testable.
export type PushCardState =
  | 'unsupported'
  | 'ios_not_installed'
  | 'available'
  | 'denied'
  | 'active';

export type PushEnvironment = {
  userAgent: string;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  standalone: boolean;
  permission: 'default' | 'granted' | 'denied' | undefined;
  hasSubscription: boolean;
};

const IOS_DEVICE = /iPhone|iPad|iPod/i;

/** Decide which spec state the card shows. Order matters: iOS first, because
 * Safari outside the installed app exposes no PushManager at all. */
export function pushCardState(env: PushEnvironment): PushCardState {
  if (IOS_DEVICE.test(env.userAgent) && !env.standalone)
    return 'ios_not_installed';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification)
    return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  if (env.permission === 'granted' && env.hasSubscription) return 'active';
  return 'available';
}

/** URL-safe base64 VAPID public key to the bytes pushManager.subscribe needs. */
export function urlBase64ToUint8Array(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid key');
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** The subscription route only accepts fr or ar; English falls back to fr. */
export function pushRouteLocale(locale: 'en' | 'fr' | 'ar'): 'fr' | 'ar' {
  return locale === 'ar' ? 'ar' : 'fr';
}
