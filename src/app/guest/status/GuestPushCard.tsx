'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  pushCardState,
  pushRouteLocale,
  urlBase64ToUint8Array,
  type PushCardState,
} from './guest-push-card';

type SupportedLocale = 'en' | 'fr' | 'ar';
type CardState = PushCardState | 'checking' | 'hidden';

type Copy = {
  heading: string;
  states: Record<PushCardState, string>;
  enable: string;
  disable: string;
  failed: string;
};

// docs/design/pwa-push.md section 5. English is the status page's existing
// fallback locale; fr and ar follow the spec copy.
const COPY: Record<SupportedLocale, Copy> = {
  en: {
    heading: 'Notifications',
    states: {
      unsupported:
        'Your browser does not support notifications. Keep this page open or ask the front desk for the printed link.',
      ios_not_installed:
        'On iPhone: tap Share, then "Add to Home Screen", and open Tabibi from the icon.',
      available: 'Get an alert when your turn is near.',
      denied:
        'Notifications are blocked in the browser. You can allow them in the site settings.',
      active: 'Notifications are on for this device.',
    },
    enable: 'Turn on notifications',
    disable: 'Turn off',
    failed: 'Could not change notifications. Please try again.',
  },
  fr: {
    heading: 'Notifications',
    states: {
      unsupported:
        'Votre navigateur ne permet pas les notifications. Gardez cette page ouverte ou demandez le lien imprimé à l’accueil.',
      ios_not_installed:
        'Sur iPhone : touchez Partager, puis « Sur l’écran d’accueil », et ouvrez Tabibi depuis l’icône.',
      available: 'Recevez une alerte quand votre tour approche.',
      denied:
        'Notifications bloquées dans le navigateur. Vous pouvez les autoriser dans les réglages du site.',
      active: 'Notifications activées sur cet appareil.',
    },
    enable: 'Activer les notifications',
    disable: 'Désactiver',
    failed: 'Impossible de modifier les notifications. Veuillez réessayer.',
  },
  ar: {
    heading: 'الإشعارات',
    states: {
      unsupported:
        'متصفحك لا يدعم الإشعارات. أبقِ هذه الصفحة مفتوحة أو اطلب الرابط المطبوع من الاستقبال.',
      ios_not_installed:
        'على iPhone: اضغط على مشاركة، ثم «إضافة إلى الشاشة الرئيسية»، وافتح طبيبي من الأيقونة.',
      available: 'احصل على تنبيه عندما يقترب دورك.',
      denied:
        'الإشعارات محظورة في المتصفح. يمكنك السماح بها من إعدادات الموقع.',
      active: 'الإشعارات مفعّلة على هذا الجهاز.',
    },
    enable: 'تفعيل الإشعارات',
    disable: 'إيقاف',
    failed: 'تعذر تغيير الإشعارات. يرجى المحاولة مرة أخرى.',
  },
};

function detectGuestLocale(): SupportedLocale {
  if (typeof navigator === 'undefined') return 'en';
  const locale = navigator.language.toLowerCase();
  if (locale.startsWith('ar')) return 'ar';
  if (locale.startsWith('fr')) return 'fr';
  return 'en';
}

function subscribeToGuestLocale(): () => void {
  return () => undefined;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function detect(): Promise<CardState> {
  const hasServiceWorker = 'serviceWorker' in navigator;
  const hasPushManager = 'PushManager' in window;
  const hasNotification = 'Notification' in window;
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const supported = hasServiceWorker && hasPushManager && hasNotification;
  if (supported) {
    // Without a configured VAPID key the feature is off and the product
    // behaves as it does today: no card at all.
    const key = await fetch('/api/guest/push-subscription/key', {
      cache: 'no-store',
    }).catch(() => null);
    if (!key || !key.ok) return 'hidden';
  }
  const subscription = supported
    ? await currentSubscription().catch(() => null)
    : null;
  return pushCardState({
    userAgent: navigator.userAgent,
    hasServiceWorker,
    hasPushManager,
    hasNotification,
    standalone,
    permission: hasNotification ? Notification.permission : undefined,
    hasSubscription: subscription !== null,
  });
}

/** Notifications card on /guest/status. Credential: the status cookie only. */
export function GuestPushCard() {
  const locale = useSyncExternalStore<SupportedLocale>(
    subscribeToGuestLocale,
    detectGuestLocale,
    () => 'en',
  );
  const [state, setState] = useState<CardState>('checking');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = COPY[locale];

  useEffect(() => {
    let cancelled = false;
    void detect()
      .catch((): CardState => 'hidden')
      .then((next) => {
        if (!cancelled) setState(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setBusy(true);
    setFailed(false);
    try {
      // The permission prompt appears only here, on the guest's tap.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'available');
        return;
      }
      const keyResponse = await fetch('/api/guest/push-subscription/key', {
        cache: 'no-store',
      });
      if (!keyResponse.ok) throw new Error('key');
      const { publicKey } = (await keyResponse.json()) as {
        publicKey: string;
      };
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      const response = await fetch('/api/guest/push-subscription', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ...subscription.toJSON(),
          locale: pushRouteLocale(locale),
        }),
      });
      if (!response.ok) {
        await subscription.unsubscribe().catch(() => false);
        throw new Error('bind');
      }
      setState('active');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setFailed(false);
    try {
      const subscription = await currentSubscription();
      const response = await fetch('/api/guest/push-subscription', {
        method: 'DELETE',
        headers: JSON_HEADERS,
        body: JSON.stringify(
          subscription ? { endpoint: subscription.endpoint } : {},
        ),
      });
      if (!response.ok) throw new Error('unbind');
      await subscription?.unsubscribe().catch(() => false);
      setState('available');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (state === 'checking' || state === 'hidden') return null;
  return (
    <section
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      className="gs-page gs-push"
      aria-labelledby="gs-push-heading"
      data-testid="guest-push-card"
    >
      <div className="gs-card">
        <h2 id="gs-push-heading">{copy.heading}</h2>
        <p role="status">{copy.states[state]}</p>
        {failed ? <p role="alert">{copy.failed}</p> : null}
        {state === 'available' ? (
          <button
            type="button"
            className="tb-button tb-button--primary"
            disabled={busy}
            onClick={() => void enable()}
          >
            {copy.enable}
          </button>
        ) : null}
        {state === 'active' ? (
          <button
            type="button"
            className="tb-button tb-button--secondary"
            disabled={busy}
            onClick={() => void disable()}
          >
            {copy.disable}
          </button>
        ) : null}
      </div>
    </section>
  );
}
