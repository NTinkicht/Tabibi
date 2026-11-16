import webpush from 'web-push';

/**
 * VAPID configuration (docs/design/pwa-push.md section 4). The keys come only
 * from runtime configuration. When any value is missing or malformed the push
 * sender is simply not registered (returns undefined): startup never fails
 * and the product behaves exactly as without push.
 */
export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function loadVapidConfig(
  env: Record<string, string | undefined> = process.env,
): VapidConfig | undefined {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return undefined;
  try {
    // Validates subject (https: or mailto:) and both key encodings.
    webpush.generateRequestDetails(
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/x',
        keys: {
          p256dh:
            'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
          auth: 'tBHItJI5svbpez7KI4CCXg',
        },
      },
      'x',
      { vapidDetails: { subject, publicKey, privateKey } },
    );
  } catch {
    return undefined;
  }
  return { publicKey, privateKey, subject };
}
