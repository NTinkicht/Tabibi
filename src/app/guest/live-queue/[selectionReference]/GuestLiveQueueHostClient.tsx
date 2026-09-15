'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

type SupportedLocale = 'ar' | 'fr';
type ContactPreference = 'none' | 'phone' | 'email';

type BookingResult = {
  guestBearer: string;
  queueLabel: string;
};

type LiveQueueData = {
  bookingState: string;
  queueState: string;
};

type HostPhase =
  | { kind: 'form' }
  | { kind: 'booking' }
  | { kind: 'booking_failed' }
  | { kind: 'live'; bearer: string; queueLabel: string };

const TERMINAL_VALUES = new Set(['completed', 'cancelled', 'no_show']);
const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_TRANSIENT_FAILURES = RETRY_DELAYS_MS.length;

type Copy = {
  dir: 'rtl' | 'ltr';
  title: string;
  subtitle: string;
  privateDisplayName: string;
  contactPhone: string;
  contactEmail: string;
  contactPreferenceLabel: string;
  contactPreferenceNone: string;
  contactPreferencePhone: string;
  contactPreferenceEmail: string;
  submit: string;
  submitting: string;
  bookingFailed: string;
  bookingFailedBody: string;
  retry: string;
  loading: string;
  yourLabel: string;
  status: string;
  unavailable: string;
  unavailableBody: string;
  stale: string;
  staleBody: string;
  offline: string;
  offlineBody: string;
  manualRetry: string;
  visitStatus: string;
  bookingStates: Record<string, string>;
  queueStates: Record<string, string>;
};

const COPY: Record<SupportedLocale, Copy> = {
  fr: {
    dir: 'ltr',
    title: 'Tabibi',
    subtitle: 'Réserver votre visite',
    privateDisplayName: 'Votre nom',
    contactPhone: 'Téléphone (optionnel)',
    contactEmail: 'Email (optionnel)',
    contactPreferenceLabel: 'Préférence de contact',
    contactPreferenceNone: 'Aucune',
    contactPreferencePhone: 'Téléphone',
    contactPreferenceEmail: 'Email',
    submit: 'Confirmer la réservation',
    submitting: 'Confirmation en cours…',
    bookingFailed: 'Réservation indisponible',
    bookingFailedBody:
      'Ce créneau n’est plus disponible ou la demande a échoué. Veuillez réessayer.',
    retry: 'Réessayer',
    loading: 'Chargement de votre statut…',
    yourLabel: 'Votre numéro :',
    status: 'Statut :',
    unavailable: 'Accès indisponible',
    unavailableBody:
      'Votre session sécurisée a expiré ou n’est plus valide. Revenez depuis votre lien de réservation.',
    stale: 'Statut potentiellement obsolète',
    staleBody: 'Nouvelle tentative automatique en cours.',
    offline: 'Connexion interrompue',
    offlineBody:
      'Nous n’avons pas pu actualiser votre statut. Réessayez manuellement.',
    manualRetry: 'Réessayer maintenant',
    visitStatus: 'Statut de la visite',
    bookingStates: {
      confirmed: 'confirmée',
      checked_in: 'enregistré',
      completed: 'terminée',
      cancelled: 'annulée',
      no_show: 'absent',
    },
    queueStates: {
      waiting: 'en attente',
      checked_in: 'enregistré',
      called: 'appelé',
      in_consultation: 'en consultation',
      completed: 'terminé',
      cancelled: 'annulé',
      no_show: 'absent',
    },
  },
  ar: {
    dir: 'rtl',
    title: 'طبيبي',
    subtitle: 'احجز زيارتك',
    privateDisplayName: 'اسمك',
    contactPhone: 'الهاتف (اختياري)',
    contactEmail: 'البريد الإلكتروني (اختياري)',
    contactPreferenceLabel: 'تفضيل الاتصال',
    contactPreferenceNone: 'بدون',
    contactPreferencePhone: 'الهاتف',
    contactPreferenceEmail: 'البريد الإلكتروني',
    submit: 'تأكيد الحجز',
    submitting: 'جارٍ التأكيد…',
    bookingFailed: 'الحجز غير متاح',
    bookingFailedBody:
      'لم يعد هذا الموعد متاحًا أو فشل الطلب. يرجى المحاولة مرة أخرى.',
    retry: 'إعادة المحاولة',
    loading: 'جارٍ تحميل حالتك…',
    yourLabel: 'رقمك:',
    status: 'الحالة:',
    unavailable: 'الوصول غير متاح',
    unavailableBody:
      'انتهت جلستك الآمنة أو لم تعد صالحة. عد من رابط الحجز الخاص بك.',
    stale: 'قد تكون الحالة قديمة',
    staleBody: 'إعادة المحاولة التلقائية جارية.',
    offline: 'انقطع الاتصال',
    offlineBody: 'تعذر تحديث حالتك. أعد المحاولة يدويًا.',
    manualRetry: 'إعادة المحاولة الآن',
    visitStatus: 'حالة الزيارة',
    bookingStates: {
      confirmed: 'مؤكدة',
      checked_in: 'تم تسجيل الوصول',
      completed: 'مكتملة',
      cancelled: 'ملغاة',
      no_show: 'لم يحضر',
    },
    queueStates: {
      waiting: 'في الانتظار',
      checked_in: 'تم تسجيل الوصول',
      called: 'تم النداء',
      in_consultation: 'في الاستشارة',
      completed: 'مكتملة',
      cancelled: 'ملغاة',
      no_show: 'لم يحضر',
    },
  },
};

function subscribeToLocale(): () => void {
  return () => undefined;
}

function detectLocale(): SupportedLocale {
  if (typeof navigator === 'undefined') return 'fr';
  return navigator.language.toLowerCase().startsWith('ar') ? 'ar' : 'fr';
}

function isTerminal(data: LiveQueueData): boolean {
  return (
    TERMINAL_VALUES.has(data.bookingState) ||
    TERMINAL_VALUES.has(data.queueState)
  );
}

function retryAfterMs(response: Response, fallback: number): number {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

/**
 * Trusted bearer-producing host for WU64: submits the booking, receives the
 * guest bearer from the same-document response, and hands it to the
 * live-queue view through in-memory component state only. The value never
 * touches a URL, browser storage, cookie, or the DOM outside this handoff.
 */
export function GuestLiveQueueHostClient({
  selectionReference,
}: {
  selectionReference: string;
}) {
  const locale = useSyncExternalStore<SupportedLocale>(
    subscribeToLocale,
    detectLocale,
    () => 'fr',
  );
  const copy = COPY[locale];
  const [phase, setPhase] = useState<HostPhase>({ kind: 'form' });
  const [preferredLocale, setPreferredLocale] =
    useState<SupportedLocale>(locale);
  const [privateDisplayName, setPrivateDisplayName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPreference, setContactPreference] =
    useState<ContactPreference>('none');

  const submitBooking = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPhase({ kind: 'booking' });
    try {
      const response = await fetch('/api/public/bookings', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          selectionReference,
          privateDisplayName,
          contactPhone: contactPhone.trim().length > 0 ? contactPhone : null,
          contactEmail: contactEmail.trim().length > 0 ? contactEmail : null,
          preferredLocale,
          contactPreference,
        }),
      });
      if (!response.ok) {
        setPhase({ kind: 'booking_failed' });
        return;
      }
      const result = (await response.json()) as BookingResult;
      const bearer = result.guestBearer;
      const queueLabel = result.queueLabel;
      setPhase({ kind: 'live', bearer, queueLabel });
    } catch {
      setPhase({ kind: 'booking_failed' });
    }
  };

  if (phase.kind === 'live') {
    return (
      <LiveQueueView
        bearer={phase.bearer}
        queueLabel={phase.queueLabel}
        copy={copy}
        locale={locale}
      />
    );
  }

  return (
    <section lang={locale} dir={copy.dir} aria-live="polite">
      <h1>{copy.title}</h1>
      <p>{copy.subtitle}</p>
      {phase.kind === 'booking_failed' ? (
        <div role="alert">
          <h2>{copy.bookingFailed}</h2>
          <p>{copy.bookingFailedBody}</p>
        </div>
      ) : null}
      <form onSubmit={submitBooking}>
        <label>
          {copy.privateDisplayName}
          <input
            type="text"
            required
            value={privateDisplayName}
            onChange={(event) => setPrivateDisplayName(event.target.value)}
            disabled={phase.kind === 'booking'}
          />
        </label>
        <label>
          {copy.contactPhone}
          <input
            type="tel"
            value={contactPhone}
            onChange={(event) => setContactPhone(event.target.value)}
            disabled={phase.kind === 'booking'}
          />
        </label>
        <label>
          {copy.contactEmail}
          <input
            type="email"
            value={contactEmail}
            onChange={(event) => setContactEmail(event.target.value)}
            disabled={phase.kind === 'booking'}
          />
        </label>
        <fieldset disabled={phase.kind === 'booking'}>
          <legend>{copy.contactPreferenceLabel}</legend>
          {(
            [
              ['none', copy.contactPreferenceNone],
              ['phone', copy.contactPreferencePhone],
              ['email', copy.contactPreferenceEmail],
            ] as const
          ).map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="contactPreference"
                value={value}
                checked={contactPreference === value}
                onChange={() => setContactPreference(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset disabled={phase.kind === 'booking'}>
          <legend>{copy.title}</legend>
          {(['fr', 'ar'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="preferredLocale"
                value={value}
                checked={preferredLocale === value}
                onChange={() => setPreferredLocale(value)}
              />
              {value === 'fr' ? 'Français' : 'العربية'}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={phase.kind === 'booking'}>
          {phase.kind === 'booking' ? copy.submitting : copy.submit}
        </button>
      </form>
    </section>
  );
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'active'; data: LiveQueueData }
  | { kind: 'stale'; data: LiveQueueData | null; exhausted: boolean }
  | { kind: 'unavailable' }
  | { kind: 'terminal'; data: LiveQueueData };

function LiveQueueView({
  bearer,
  queueLabel,
  copy,
  locale,
}: {
  bearer: string;
  queueLabel: string;
  copy: Copy;
  locale: SupportedLocale;
}) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const manualRetryRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let terminalReached = false;
    let currentBearer: string | null = bearer;
    let inFlight = false;
    let consecutiveFailures = 0;
    let lastData: LiveQueueData | null = null;
    let hideAbort = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const clearScheduled = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
    };

    const scheduleNext = (delay: number) => {
      clearScheduled();
      timeoutId = setTimeout(() => void poll(), delay);
    };

    const stopForRejection = () => {
      terminalReached = true;
      currentBearer = null;
      clearScheduled();
      if (!cancelled) setState({ kind: 'unavailable' });
    };

    const stopForTerminal = (data: LiveQueueData) => {
      terminalReached = true;
      currentBearer = null;
      clearScheduled();
      if (!cancelled) setState({ kind: 'terminal', data });
    };

    const poll = async () => {
      if (cancelled || terminalReached || inFlight) return;
      if (document.visibilityState === 'hidden') return;
      if (!currentBearer) {
        stopForRejection();
        return;
      }
      inFlight = true;
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      let retryAfterOverride: number | null = null;
      try {
        const response = await fetch('/api/public/bookings/live-queue-status', {
          method: 'GET',
          cache: 'no-store',
          headers: {
            authorization: `Bearer ${currentBearer}`,
            accept: 'application/json',
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutHandle);
        if (cancelled || terminalReached) return;
        if (response.status === 400) {
          stopForRejection();
          return;
        }
        if (!response.ok) {
          retryAfterOverride = retryAfterMs(response, 0) || null;
          throw new Error('transient');
        }
        const data = (await response.json()) as LiveQueueData;
        if (cancelled || terminalReached) return;
        consecutiveFailures = 0;
        lastData = data;
        if (isTerminal(data)) {
          stopForTerminal(data);
          return;
        }
        setState({ kind: 'active', data });
        scheduleNext(POLL_INTERVAL_MS);
      } catch {
        clearTimeout(timeoutHandle);
        if (cancelled || terminalReached) return;
        if (hideAbort) {
          hideAbort = false;
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures > MAX_TRANSIENT_FAILURES) {
          clearScheduled();
          setState({ kind: 'stale', data: lastData, exhausted: true });
          return;
        }
        const baseDelay = RETRY_DELAYS_MS[consecutiveFailures - 1];
        const delay =
          retryAfterOverride !== null
            ? Math.max(retryAfterOverride, baseDelay)
            : baseDelay;
        setState({ kind: 'stale', data: lastData, exhausted: false });
        scheduleNext(Math.min(delay, MAX_RETRY_AFTER_MS));
      } finally {
        inFlight = false;
      }
    };

    manualRetryRef.current = () => {
      if (cancelled || terminalReached || inFlight) return;
      consecutiveFailures = 0;
      clearScheduled();
      void poll();
    };

    const handleVisibilityChange = () => {
      if (cancelled || terminalReached) return;
      if (document.visibilityState === 'hidden') {
        clearScheduled();
        if (inFlight) {
          hideAbort = true;
        }
        return;
      }
      if (!inFlight) {
        clearScheduled();
        void poll();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    void poll();

    return () => {
      cancelled = true;
      currentBearer = null;
      clearScheduled();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [bearer]);

  const shell = (content: React.ReactNode) => (
    <section lang={locale} dir={copy.dir} aria-live="polite">
      <h1>{copy.title}</h1>
      <p>
        <strong>{copy.yourLabel}</strong> {queueLabel}
      </p>
      {content}
    </section>
  );

  if (state.kind === 'loading') return shell(<p>{copy.loading}</p>);

  if (state.kind === 'unavailable') {
    return shell(
      <>
        <h2>{copy.unavailable}</h2>
        <p>{copy.unavailableBody}</p>
      </>,
    );
  }

  if (state.kind === 'terminal') {
    return shell(
      <>
        <h2>{copy.visitStatus}</h2>
        <p>
          {copy.bookingStates[state.data.bookingState] ??
            state.data.bookingState}
        </p>
      </>,
    );
  }

  if (state.kind === 'stale') {
    return shell(
      <>
        {state.data ? (
          <p>
            <strong>{copy.status}</strong>{' '}
            {copy.queueStates[state.data.queueState] ?? state.data.queueState}
          </p>
        ) : null}
        <div role="status">
          <h2>{state.exhausted ? copy.offline : copy.stale}</h2>
          <p>{state.exhausted ? copy.offlineBody : copy.staleBody}</p>
          {state.exhausted ? (
            <button type="button" onClick={() => manualRetryRef.current()}>
              {copy.manualRetry}
            </button>
          ) : null}
        </div>
      </>,
    );
  }

  return shell(
    <p>
      <strong>{copy.status}</strong>{' '}
      {copy.queueStates[state.data.queueState] ?? state.data.queueState}
    </p>,
  );
}
