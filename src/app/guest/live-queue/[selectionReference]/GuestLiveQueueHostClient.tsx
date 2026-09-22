'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

type SupportedLocale = 'ar' | 'fr';
type ContactPreference = 'none' | 'phone' | 'email';

type BookingResult = {
  guestBearer: string;
  queueLabel: string;
};

type LiveQueueEta = {
  patientsAhead: number;
  minWaitMinutes: number;
  maxWaitMinutes: number;
  estimateSource: 'fallback' | 'historical_median' | 'observed_median';
  delayStatus?: 'declared' | null;
  summary?: {
    midpointMinutes: number;
    uncertaintyWidthMinutes: number;
    confidence: 'high' | 'medium' | 'low';
  };
};

type LiveQueueData = {
  bookingState: string;
  queueState: string;
  pauseStatus?: 'paused' | null;
  closureStatus?: 'closed' | null;
  activeConsultationRemainingMinutes: number | null;
  eta: LiveQueueEta | null;
};

type HostPhase =
  | { kind: 'form' }
  | { kind: 'booking' }
  | { kind: 'booking_failed' }
  | { kind: 'live'; bearer: string | undefined; queueLabel: string };

const TERMINAL_VALUES = new Set(['completed', 'cancelled', 'no_show']);
// Non-terminal queue-state progression, oldest to newest. Used only to stop a
// stale/out-of-order response (poll or check-in) from visually regressing the
// display below a more-advanced state this view has already authoritatively
// observed; terminal states are handled separately and always win outright.
const QUEUE_STATE_PROGRESSION = [
  'waiting',
  'checked_in',
  'called',
  'in_consultation',
];
const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_TRANSIENT_FAILURES = RETRY_DELAYS_MS.length;
const MANUAL_REFRESH_THROTTLE_MS = 1_000;

type Copy = {
  dir: 'rtl' | 'ltr';
  title: string;
  subtitle: string;
  privateDisplayName: string;
  contactPhone: string;
  contactEmail: string;
  contactPreferenceLabel: string;
  preferredLocaleLabel: string;
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
  hiddenBody: string;
  offline: string;
  offlineBody: string;
  manualRetry: string;
  manualRetryPending: string;
  manualRetryVerified: string;
  manualRetryFailed: string;
  manualRefresh: string;
  manualRefreshPending: string;
  manualRefreshVerified: string;
  manualRefreshFailed: string;
  streamConnected: string;
  streamReconnecting: string;
  streamFallback: string;
  streamRecovered: string;
  lastVerified: string;
  visitStatus: string;
  bookingStates: Record<string, string>;
  queueStates: Record<string, string>;
  checkIn: string;
  checkInPending: string;
  checkInSuccess: string;
  checkInAlreadyDone: string;
  checkInRejected: string;
  checkInTransient: string;
  etaHeading: string;
  etaPatientsAhead: (count: number) => string;
  etaWaitRange: (minMinutes: number, maxMinutes: number) => string;
  etaConfidence: Record<'high' | 'medium' | 'low', string>;
  etaDelayNotice: string;
  pausedHeading: string;
  pausedBody: string;
  closedHeading: string;
  closedBody: string;
  activeConsultationHeading: string;
  activeConsultationRemaining: (minutes: number) => string;
  estimateExplainerLink: string;
  estimateExplainerNewTab: string;
};

// Arabic noun-number agreement for دقيقة (minute): 1/2 take dedicated
// singular/dual forms, 3–10 take the plural noun, 11+ reverts to the
// singular noun after the numeral.
function arabicMinuteCount(minutes: number): string {
  if (minutes === 1) return 'دقيقة واحدة';
  if (minutes === 2) return 'دقيقتان';
  if (minutes >= 3 && minutes <= 10) return `${minutes} دقائق`;
  return `${minutes} دقيقة`;
}

const COPY: Record<SupportedLocale, Copy> = {
  fr: {
    dir: 'ltr',
    title: 'Tabibi',
    subtitle: 'Réserver votre visite',
    privateDisplayName: 'Votre nom',
    contactPhone: 'Téléphone (optionnel)',
    contactEmail: 'Email (optionnel)',
    contactPreferenceLabel: 'Préférence de contact',
    preferredLocaleLabel: 'Langue préférée',
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
    hiddenBody:
      'Les mises à jour sont en pause pendant que cet onglet est en arrière-plan.',
    offline: 'Connexion interrompue',
    offlineBody:
      'Nous n’avons pas pu actualiser votre statut. Réessayez manuellement.',
    manualRetry: 'Réessayer maintenant',
    manualRetryPending: 'Nouvelle tentative en cours…',
    manualRetryVerified: 'Nouvelle tentative réussie. Le statut a été vérifié.',
    manualRetryFailed:
      'La nouvelle tentative a échoué. La dernière heure vérifiée reste affichée.',
    manualRefresh: 'Actualiser mon statut',
    manualRefreshPending: 'Actualisation en cours…',
    manualRefreshVerified:
      'Nouvelle vérification réussie. Le statut peut avoir changé depuis cette vérification.',
    manualRefreshFailed:
      'La nouvelle vérification a échoué. La dernière heure vérifiée reste affichée.',
    streamConnected:
      'Notifications en direct disponibles. Seule une vérification réussie confirme votre statut.',
    streamReconnecting:
      'Reconnexion aux notifications en direct en cours. La vérification automatique continue.',
    streamFallback:
      'Notifications en direct interrompues. La vérification automatique continue ; vous pouvez aussi utiliser « Actualiser mon statut ».',
    streamRecovered:
      'Notifications en direct rétablies. La dernière vérification affichée reste la référence.',
    lastVerified: 'Dernière vérification :',
    visitStatus: 'Statut de la visite',
    checkIn: 'Confirmer ma présence',
    checkInPending: 'Confirmation en cours…',
    checkInSuccess: 'Votre présence a été confirmée.',
    checkInAlreadyDone: 'Votre présence était déjà confirmée.',
    checkInRejected: 'Impossible de confirmer votre présence pour le moment.',
    checkInTransient: 'La confirmation a échoué. Veuillez réessayer.',
    etaHeading: 'Temps d’attente estimé',
    etaPatientsAhead: (count) =>
      count === 0
        ? 'Vous êtes le prochain'
        : count === 1
          ? '1 personne devant vous'
          : `${count} personnes devant vous`,
    etaWaitRange: (minMinutes, maxMinutes) =>
      minMinutes === maxMinutes
        ? `Environ ${minMinutes} min`
        : `Environ ${minMinutes}–${maxMinutes} min`,
    etaConfidence: {
      high: 'Confiance de l’estimation: élevée',
      medium: 'Confiance de l’estimation: moyenne',
      low: 'Confiance de l’estimation: faible',
    },
    etaDelayNotice:
      'Un retard du médecin est pris en compte dans cette estimation.',
    pausedHeading: 'File temporairement en pause',
    pausedBody:
      'La clinique a temporairement interrompu la file. Une nouvelle estimation apparaîtra à la reprise.',
    closedHeading: 'File fermée',
    closedBody:
      'La clinique a fermé cette file. Aucune nouvelle estimation n’est disponible.',
    activeConsultationHeading: 'Consultation en cours',
    activeConsultationRemaining: (minutes) =>
      minutes === 1
        ? 'Temps restant estimé : environ 1 min'
        : `Temps restant estimé : environ ${minutes} min`,
    estimateExplainerLink: 'Pourquoi ces estimations changent',
    estimateExplainerNewTab: 's’ouvre dans un nouvel onglet',
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
    preferredLocaleLabel: 'اللغة المفضلة',
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
    hiddenBody: 'التحديثات متوقفة مؤقتًا أثناء وجود هذا التبويب في الخلفية.',
    offline: 'انقطع الاتصال',
    offlineBody: 'تعذر تحديث حالتك. أعد المحاولة يدويًا.',
    manualRetry: 'إعادة المحاولة الآن',
    manualRetryPending: 'إعادة المحاولة جارية…',
    manualRetryVerified: 'نجحت إعادة المحاولة. تم التحقق من حالتك.',
    manualRetryFailed: 'فشلت إعادة المحاولة. يبقى وقت آخر تحقق ناجح معروضًا.',
    manualRefresh: 'تحديث حالتي',
    manualRefreshPending: 'جارٍ تحديث حالتك…',
    manualRefreshVerified: 'نجح التحقق الجديد. قد تتغير الحالة بعد هذا التحقق.',
    manualRefreshFailed: 'فشل التحقق الجديد. يبقى وقت آخر تحقق ناجح معروضًا.',
    streamConnected:
      'الإشعارات المباشرة متاحة. لا تُؤكَّد حالتك إلا بعد تحقق ناجح.',
    streamReconnecting:
      'تجري إعادة الاتصال بالإشعارات المباشرة. يستمر التحقق التلقائي من الحالة.',
    streamFallback:
      'انقطعت الإشعارات المباشرة. يستمر التحقق التلقائي ويمكنك أيضًا استخدام « تحديث حالتي ».',
    streamRecovered:
      'عادت الإشعارات المباشرة. يظل وقت آخر تحقق معروض هو المرجع.',
    lastVerified: 'آخر تحقق من الحالة:',
    visitStatus: 'حالة الزيارة',
    checkIn: 'تأكيد الحضور',
    checkInPending: 'جارٍ التأكيد…',
    checkInSuccess: 'تم تأكيد حضورك.',
    checkInAlreadyDone: 'كان حضورك مؤكدًا بالفعل.',
    checkInRejected: 'يتعذر تأكيد حضورك في الوقت الحالي.',
    checkInTransient: 'فشل التأكيد. يرجى إعادة المحاولة.',
    etaHeading: 'وقت الانتظار المقدر',
    etaPatientsAhead: (count) =>
      count === 0
        ? 'أنت التالي'
        : count === 1
          ? 'شخص واحد أمامك'
          : `${count} أشخاص أمامك`,
    etaWaitRange: (minMinutes, maxMinutes) =>
      minMinutes === maxMinutes
        ? `حوالي ${minMinutes} دقيقة`
        : `حوالي ${minMinutes}–${maxMinutes} دقيقة`,
    etaConfidence: {
      high: 'ثقة التقدير: عالية',
      medium: 'ثقة التقدير: متوسطة',
      low: 'ثقة التقدير: منخفضة',
    },
    etaDelayNotice: 'تشمل هذه المدة المقدرة تأخر الطبيب.',
    pausedHeading: 'قائمة الانتظار متوقفة مؤقتًا',
    pausedBody:
      'أوقفت العيادة قائمة الانتظار مؤقتًا. سيظهر تقدير جديد عند استئنافها.',
    closedHeading: 'قائمة الانتظار مغلقة',
    closedBody: 'أغلقت العيادة قائمة الانتظار. لا يتوفر تقدير جديد.',
    activeConsultationHeading: 'الاستشارة جارية الآن',
    activeConsultationRemaining: (minutes) =>
      `الوقت المتبقي المقدر: حوالي ${arabicMinuteCount(minutes)}`,
    estimateExplainerLink: 'لماذا تتغير هذه التقديرات',
    estimateExplainerNewTab: 'يُفتح في علامة تبويب جديدة',
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

function queueStateRank(value: string): number {
  return QUEUE_STATE_PROGRESSION.indexOf(value);
}

// Never let a queue-state value regress below a floor this view has already
// authoritatively observed (from either a poll or a successful/reconciled
// check-in). Values outside the known non-terminal progression -- including
// every terminal value, which callers handle separately -- are passed
// through unclamped rather than compared.
function clampQueueState(value: string, floor: string | null): string {
  if (!floor) return value;
  const valueRank = queueStateRank(value);
  const floorRank = queueStateRank(floor);
  if (valueRank === -1 || floorRank === -1) return value;
  return valueRank < floorRank ? floor : value;
}

function EtaStatus({
  eta,
  copy,
  locale,
}: {
  eta: LiveQueueEta;
  copy: Copy;
  locale: SupportedLocale;
}) {
  return (
    <div role="status">
      <h2>{copy.etaHeading}</h2>
      <p>{copy.etaPatientsAhead(eta.patientsAhead)}</p>
      <p>{copy.etaWaitRange(eta.minWaitMinutes, eta.maxWaitMinutes)}</p>
      {eta.delayStatus === 'declared' ? <p>{copy.etaDelayNotice}</p> : null}
      {eta.summary ? <p>{copy.etaConfidence[eta.summary.confidence]}</p> : null}
      <p>
        <a
          href={`/guest/eta-explained?lang=${locale}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby="tabibi-wait-eta-explainer-hint"
        >
          {copy.estimateExplainerLink}
        </a>{' '}
        <small id="tabibi-wait-eta-explainer-hint">
          ({copy.estimateExplainerNewTab})
        </small>
      </p>
    </div>
  );
}

function PausedStatus({ copy }: { copy: Copy }) {
  return (
    <div role="status">
      <h2>{copy.pausedHeading}</h2>
      <p>{copy.pausedBody}</p>
    </div>
  );
}

function ClosedStatus({ copy }: { copy: Copy }) {
  return (
    <div role="status">
      <h2>{copy.closedHeading}</h2>
      <p>{copy.closedBody}</p>
    </div>
  );
}

// Deliberately its own status region with its own heading, never merged into
// EtaStatus above: once the guest's own entry is in_consultation, the
// pre-existing waiting-range estimate no longer describes anything the
// guest is waiting for, and conflating the two would misrepresent this
// entry's own remaining consultation time as a queue wait.
function ActiveConsultationStatus({
  minutes,
  copy,
  locale,
}: {
  minutes: number;
  copy: Copy;
  locale: SupportedLocale;
}) {
  return (
    <div role="status">
      <h2>{copy.activeConsultationHeading}</h2>
      <p>{copy.activeConsultationRemaining(minutes)}</p>
      <p>
        <a
          href={`/guest/eta-explained?lang=${locale}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby="tabibi-consultation-eta-explainer-hint"
        >
          {copy.estimateExplainerLink}
        </a>{' '}
        <small id="tabibi-consultation-eta-explainer-hint">
          ({copy.estimateExplainerNewTab})
        </small>
      </p>
    </div>
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
  // Until a guest explicitly selects a language, follow the detected UI
  // locale (which may change from the SSR French fallback after hydration).
  const [chosenLocale, setChosenLocale] = useState<SupportedLocale | null>(
    null,
  );
  const preferredLocale = chosenLocale ?? locale;
  const [privateDisplayName, setPrivateDisplayName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPreference, setContactPreference] =
    useState<ContactPreference>('none');
  const idempotencyKeyRef = useRef<string | null>(null);
  // React disables the form via `phase.kind === 'booking'` only after this
  // handler returns and a re-render commits, so a rapid double click/Enter
  // (or a synthesised double submit) can re-enter this handler before that
  // happens. This ref is set synchronously, before any `await`, so the
  // second re-entrant call is rejected immediately instead of racing a
  // second POST.
  const bookingInFlightRef = useRef(false);

  const submitBooking = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (bookingInFlightRef.current) return;
    bookingInFlightRef.current = true;
    setPhase({ kind: 'booking' });
    idempotencyKeyRef.current ??= crypto.randomUUID();
    try {
      const response = await fetch('/api/public/bookings', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKeyRef.current,
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
      idempotencyKeyRef.current = null;
      setPhase({
        kind: 'live',
        bearer: result.guestBearer,
        queueLabel: result.queueLabel,
      });
    } catch {
      setPhase({ kind: 'booking_failed' });
    } finally {
      bookingInFlightRef.current = false;
    }
  };

  if (phase.kind === 'live') {
    return (
      <LiveQueueView
        bearer={phase.bearer}
        onBearerAccepted={() =>
          setPhase((current) =>
            current.kind === 'live'
              ? { ...current, bearer: undefined }
              : current,
          )
        }
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
          <legend>{copy.preferredLocaleLabel}</legend>
          {(['fr', 'ar'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="preferredLocale"
                value={value}
                checked={preferredLocale === value}
                onChange={() => setChosenLocale(value)}
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
  | {
      kind: 'stale';
      data: LiveQueueData | null;
      exhausted: boolean;
      hidden?: boolean;
    }
  | { kind: 'unavailable' }
  | { kind: 'terminal'; data: LiveQueueData };

type StreamConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'fallback'
  | 'recovered';

type CheckInState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'done'; reconciled: boolean }
  | { kind: 'rejected' }
  | { kind: 'transient' };

function LiveQueueView({
  bearer,
  onBearerAccepted,
  queueLabel,
  copy,
  locale,
}: {
  bearer: string | undefined;
  onBearerAccepted: () => void;
  queueLabel: string;
  copy: Copy;
  locale: SupportedLocale;
}) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const manualRetryRef = useRef<() => void>(() => undefined);
  const manualRefreshRef = useRef<() => void>(() => undefined);
  const [manualRefreshPending, setManualRefreshPending] = useState(false);
  const [manualRefreshOutcome, setManualRefreshOutcome] = useState<
    'idle' | 'pending' | 'verified' | 'failed'
  >('idle');
  const [manualRetryPending, setManualRetryPending] = useState(false);
  const [manualRetryOutcome, setManualRetryOutcome] = useState<
    'idle' | 'pending' | 'verified' | 'failed'
  >('idle');
  const [lastVerifiedAt, setLastVerifiedAt] = useState<Date | null>(null);
  const [streamConnection, setStreamConnection] =
    useState<StreamConnectionState>('connecting');
  // Announce one outage and one recovery, not every exponentially backed-off
  // reconnect attempt; stream hints never count as authoritative freshness.
  const [streamAnnouncement, setStreamAnnouncement] = useState<
    'none' | 'fallback' | 'recovered'
  >('none');
  // Captured once on mount; later re-renders may pass `undefined` once the
  // host clears its own copy, but this ref keeps the value this view needs.
  const initialBearerRef = useRef(bearer);
  // Distinguishes a real unmount from React Strict Mode's dev-only effect
  // replay (mount -> cleanup -> mount again, synchronously, on the same
  // instance): a replay's re-setup bumps this before the deferred cleanup
  // microtask below runs, so only a true unmount clears initialBearerRef.
  const effectGenerationRef = useRef(0);
  const [checkInState, setCheckInState] = useState<CheckInState>({
    kind: 'idle',
  });
  // Reused across retries of the same logical check-in attempt (including
  // ambiguous transport failures) so the backend can reconcile a replay
  // instead of treating it as a distinct operation; cleared only once that
  // attempt reaches a definitive outcome (success, reconciled, or a generic
  // rejection).
  const checkInOperationIdRef = useRef<string | null>(null);
  // The most-advanced non-terminal queue state this view has authoritatively
  // observed, from either a poll or a successful/reconciled check-in. Shared
  // between the polling effect and submitCheckIn so a stale/out-of-order
  // response from either stream can never regress the display below it.
  const queueStateFloorRef = useRef<string | null>(null);
  // The most recent poll data, whether currently displayed as 'active' or
  // 'stale' (a transient poll failure). Shared with submitCheckIn so a
  // check-in success reconciles the display even while polling itself is
  // failing, and so a subsequent poll failure's own 'stale' render doesn't
  // fall back to pre-check-in data.
  const lastDataRef = useRef<LiveQueueData | null>(null);

  const submitCheckIn = async () => {
    if (checkInState.kind === 'pending') return;
    const bearer = initialBearerRef.current;
    if (!bearer) return;
    checkInOperationIdRef.current ??= crypto.randomUUID();
    setCheckInState({ kind: 'pending' });
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch('/api/public/bookings/check-in', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operationId: checkInOperationIdRef.current }),
        signal: controller.signal,
      });
      if (response.status === 200) {
        const result = (await response.json()) as {
          state?: unknown;
          reconciled?: unknown;
        };
        if (
          result.state === 'checked_in' &&
          typeof result.reconciled === 'boolean'
        ) {
          checkInOperationIdRef.current = null;
          queueStateFloorRef.current = clampQueueState(
            'checked_in',
            queueStateFloorRef.current,
          );
          if (
            lastDataRef.current &&
            queueStateRank(lastDataRef.current.queueState) <
              queueStateRank('checked_in')
          ) {
            lastDataRef.current = {
              ...lastDataRef.current,
              queueState: 'checked_in',
            };
          }
          setCheckInState({ kind: 'done', reconciled: result.reconciled });
          // Reflect the now-authoritatively-known transition immediately,
          // rather than waiting up to POLL_INTERVAL_MS for the next poll to
          // confirm it -- a stale in-flight poll response from before this
          // check-in cannot regress it back below the floor set above. This
          // applies whether the view is currently 'active' or 'stale' (a
          // transient poll failure does not un-know a completed check-in).
          setState((current) => {
            if (
              current.kind === 'active' &&
              queueStateRank(current.data.queueState) <
                queueStateRank('checked_in')
            ) {
              return {
                kind: 'active',
                data: { ...current.data, queueState: 'checked_in' },
              };
            }
            if (
              current.kind === 'stale' &&
              current.data &&
              queueStateRank(current.data.queueState) <
                queueStateRank('checked_in')
            ) {
              return {
                ...current,
                data: { ...current.data, queueState: 'checked_in' },
              };
            }
            return current;
          });
          return;
        }
        // A 200 that doesn't conform to the wire schema is not a trustworthy
        // success signal; keep the operationId so a retry reuses the same
        // logical attempt rather than starting a new one.
        setCheckInState({ kind: 'transient' });
        return;
      }
      if (response.status === 404) {
        checkInOperationIdRef.current = null;
        setCheckInState({ kind: 'rejected' });
        return;
      }
      // 400/503/other: keep the same operationId so a retry reuses the same
      // logical attempt rather than starting a new one.
      setCheckInState({ kind: 'transient' });
    } catch {
      setCheckInState({ kind: 'transient' });
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  useEffect(() => {
    // Report acceptance once so the host can drop its own reference; this
    // view keeps its own copy via initialBearerRef regardless of what the
    // host passes afterward.
    onBearerAccepted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const generation = ++effectGenerationRef.current;
    let cancelled = false;
    let terminalReached = false;
    let currentBearer: string | null = initialBearerRef.current ?? null;
    let inFlight = false;
    let consecutiveFailures = 0;
    let hideAbort = false;
    let resumeIfVisibleAfterHideAbort = false;
    let activeController: AbortController | null = null;
    let streamController: AbortController | null = null;
    let streamRetryId: ReturnType<typeof setTimeout> | null = null;
    let streamFailures = 0;
    let streamOutageAnnounced = false;
    let hintPending = false;
    let manualRequestPending = false;
    let manualRetryRequestPending = false;
    let lastManualRefreshAt = Number.NEGATIVE_INFINITY;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const clearScheduled = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
    };

    const clearStreamRetry = () => {
      if (streamRetryId) clearTimeout(streamRetryId);
      streamRetryId = null;
    };

    const scheduleNext = (delay: number) => {
      clearScheduled();
      timeoutId = setTimeout(() => void poll(), delay);
    };

    const stopForRejection = () => {
      terminalReached = true;
      currentBearer = null;
      initialBearerRef.current = undefined;
      clearScheduled();
      clearStreamRetry();
      streamController?.abort();
      if (!cancelled) setState({ kind: 'unavailable' });
    };

    const stopForTerminal = (data: LiveQueueData) => {
      terminalReached = true;
      currentBearer = null;
      initialBearerRef.current = undefined;
      clearScheduled();
      clearStreamRetry();
      streamController?.abort();
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
      activeController = controller;
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
        if (cancelled || terminalReached) return;
        if (response.status === 400) {
          stopForRejection();
          return;
        }
        if (!response.ok) {
          retryAfterOverride = retryAfterMs(response, 0) || null;
          throw new Error('transient');
        }
        const fetched = (await response.json()) as LiveQueueData;
        if (cancelled || terminalReached) return;
        consecutiveFailures = 0;
        hideAbort = false;
        if (isTerminal(fetched)) {
          lastDataRef.current = fetched;
          stopForTerminal(fetched);
          return;
        }
        if (fetched.closureStatus === 'closed') {
          lastDataRef.current = fetched;
          stopForTerminal(fetched);
          return;
        }
        // Never let this response regress the queue state below what a
        // prior poll or a successful/reconciled check-in already
        // established, in case it was in flight before that happened and
        // only settles now.
        const queueState = clampQueueState(
          fetched.queueState,
          queueStateFloorRef.current,
        );
        if (
          queueStateRank(queueState) >
          queueStateRank(queueStateFloorRef.current ?? '')
        ) {
          queueStateFloorRef.current = queueState;
        }
        // A clamped response is stale/out-of-order for queueState, so its own
        // eta was computed against that same stale row; keep the last
        // authoritatively-displayed eta instead of regressing to it. The
        // same applies to activeConsultationRemainingMinutes: a clamped
        // (stale) response's own value was computed for the pre-clamp state
        // and must not regress or reappear against the floor-held state.
        const eta =
          queueState === fetched.queueState
            ? fetched.eta
            : (lastDataRef.current?.eta ?? fetched.eta);
        const activeConsultationRemainingMinutes =
          queueState === fetched.queueState
            ? fetched.activeConsultationRemainingMinutes
            : (lastDataRef.current?.activeConsultationRemainingMinutes ??
              fetched.activeConsultationRemainingMinutes);
        const pauseStatus =
          queueState === fetched.queueState
            ? fetched.pauseStatus
            : lastDataRef.current
              ? lastDataRef.current.pauseStatus
              : fetched.pauseStatus;
        const data: LiveQueueData = {
          ...fetched,
          queueState,
          eta,
          activeConsultationRemainingMinutes,
          pauseStatus,
          closureStatus:
            queueState === fetched.queueState
              ? fetched.closureStatus
              : lastDataRef.current
                ? lastDataRef.current.closureStatus
                : fetched.closureStatus,
        };
        lastDataRef.current = data;
        // Only a successfully parsed canonical snapshot establishes freshness.
        // Stream hints, failed requests, and retries never advance this clock.
        setLastVerifiedAt(new Date());
        if (manualRequestPending) {
          setManualRefreshOutcome('verified');
        } else {
          setManualRefreshOutcome((previous) =>
            previous === 'failed' ? 'idle' : previous,
          );
        }
        if (manualRetryRequestPending) {
          setManualRetryOutcome('verified');
        } else {
          setManualRetryOutcome((previous) =>
            previous === 'failed' ? 'idle' : previous,
          );
        }
        setState({ kind: 'active', data });
        scheduleNext(POLL_INTERVAL_MS);
      } catch {
        if (cancelled || terminalReached) return;
        if (hideAbort) {
          if (manualRequestPending) setManualRefreshOutcome('failed');
          if (manualRetryRequestPending) setManualRetryOutcome('failed');
          hideAbort = false;
          resumeIfVisibleAfterHideAbort = true;
          return;
        }
        if (manualRequestPending) setManualRefreshOutcome('failed');
        if (manualRetryRequestPending) setManualRetryOutcome('failed');
        consecutiveFailures += 1;
        if (consecutiveFailures > MAX_TRANSIENT_FAILURES) {
          clearScheduled();
          setState({
            kind: 'stale',
            data: lastDataRef.current,
            exhausted: true,
          });
          return;
        }
        const baseDelay = RETRY_DELAYS_MS[consecutiveFailures - 1];
        const delay =
          retryAfterOverride !== null
            ? Math.max(retryAfterOverride, baseDelay)
            : baseDelay;
        setState({
          kind: 'stale',
          data: lastDataRef.current,
          exhausted: false,
        });
        scheduleNext(Math.min(delay, MAX_RETRY_AFTER_MS));
      } finally {
        clearTimeout(timeoutHandle);
        activeController = null;
        inFlight = false;
        if (manualRequestPending) {
          manualRequestPending = false;
          if (!cancelled) setManualRefreshPending(false);
        }
        if (manualRetryRequestPending) {
          manualRetryRequestPending = false;
          if (!cancelled) setManualRetryPending(false);
        }
        if (hintPending && !cancelled && !terminalReached) {
          hintPending = false;
          clearScheduled();
          void poll();
        }
        // A hide-triggered abort can settle after visibility has already
        // returned, in which case handleVisibilityChange's own immediate
        // refresh already saw inFlight=true and skipped. Self-heal here so
        // polling never stalls waiting for another visibility event.
        if (resumeIfVisibleAfterHideAbort) {
          resumeIfVisibleAfterHideAbort = false;
          if (
            !cancelled &&
            !terminalReached &&
            document.visibilityState === 'visible'
          ) {
            void poll();
          }
        }
      }
    };

    const startStream = async () => {
      if (
        cancelled ||
        terminalReached ||
        !currentBearer ||
        document.visibilityState === 'hidden'
      )
        return;
      clearStreamRetry();
      if (streamFailures > 0) setStreamConnection('reconnecting');
      const controller = new AbortController();
      streamController = controller;
      try {
        const response = await fetch('/api/public/bookings/live-queue-stream', {
          method: 'GET',
          cache: 'no-store',
          headers: {
            authorization: `Bearer ${currentBearer}`,
            accept: 'text/event-stream',
          },
          signal: controller.signal,
        });
        // Streaming is an optional change-hint lane. A 400 from that lane
        // is not authoritative proof the guest capability is revoked (the
        // endpoint might be disabled or an old test/deployment may lack it).
        // Only the canonical status request can terminate guest access.
        if (!response.ok || !response.body) throw new Error('stream rejected');
        if (cancelled || terminalReached) return;
        setStreamConnection(streamOutageAnnounced ? 'recovered' : 'connected');
        if (streamOutageAnnounced) {
          setStreamAnnouncement('recovered');
          streamOutageAnnounced = false;
        }
        streamFailures = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!cancelled && !terminalReached) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (event.split('\n').some((line) => line === 'event: change')) {
              if (inFlight) hintPending = true;
              else {
                clearScheduled();
                void poll();
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Polling remains authoritative and continues independently.
      } finally {
        if (streamController === controller) streamController = null;
        if (
          !cancelled &&
          !terminalReached &&
          document.visibilityState === 'visible'
        ) {
          streamFailures += 1;
          setStreamConnection('fallback');
          if (!streamOutageAnnounced) {
            setStreamAnnouncement('fallback');
            streamOutageAnnounced = true;
          }
          const delay = Math.min(2 ** (streamFailures - 1) * 1_000, 30_000);
          streamRetryId = setTimeout(() => void startStream(), delay);
        }
      }
    };

    manualRetryRef.current = () => {
      if (cancelled || terminalReached || inFlight) return;
      consecutiveFailures = 0;
      manualRetryRequestPending = true;
      setManualRetryOutcome('pending');
      setManualRetryPending(true);
      clearScheduled();
      void poll();
    };

    manualRefreshRef.current = () => {
      if (cancelled || terminalReached || inFlight) return;
      const now = Date.now();
      if (now - lastManualRefreshAt < MANUAL_REFRESH_THROTTLE_MS) return;
      lastManualRefreshAt = now;
      manualRequestPending = true;
      setManualRefreshOutcome('pending');
      setManualRefreshPending(true);
      clearScheduled();
      void poll();
    };

    const handleVisibilityChange = () => {
      if (cancelled || terminalReached) return;
      const exhausted = consecutiveFailures > MAX_TRANSIENT_FAILURES;
      if (document.visibilityState === 'hidden') {
        clearScheduled();
        clearStreamRetry();
        streamController?.abort();
        if (inFlight) {
          hideAbort = true;
          activeController?.abort();
        }
        // Retry exhaustion already stops automatic polling until the user
        // triggers a manual retry; hiding must not silently clear that
        // state and revert the display to a pending-auto-retry message.
        if (lastDataRef.current && !exhausted) {
          setState({
            kind: 'stale',
            data: lastDataRef.current,
            exhausted: false,
            hidden: true,
          });
        }
        return;
      }
      if (!inFlight && !exhausted) {
        clearScheduled();
        void poll();
      }
      if (!streamController) void startStream();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    void poll();
    void startStream();

    return () => {
      cancelled = true;
      currentBearer = null;
      activeController?.abort();
      streamController?.abort();
      clearScheduled();
      clearStreamRetry();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Defer the ref clear: React Strict Mode double-invokes this effect
      // (mount -> cleanup -> mount again) synchronously on the same instance
      // in dev. A replay's re-setup bumps effectGenerationRef before this
      // microtask runs, so the check below skips the clear and preserves the
      // bearer for it. A real unmount has no following setup, so the
      // generation still matches and the clear proceeds.
      queueMicrotask(() => {
        // Intentionally reading the live ref value here, not a snapshot: the
        // whole point is to detect whether a replay's re-setup incremented it
        // after this cleanup captured `generation`, above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        if (effectGenerationRef.current === generation) {
          initialBearerRef.current = undefined;
        }
      });
    };
    // The initial bearer is captured once via initialBearerRef; this effect
    // intentionally runs only on mount/unmount for this view instance.
  }, []);

  const shell = (content: React.ReactNode) => (
    <section lang={locale} dir={copy.dir} aria-live="polite">
      <h1>{copy.title}</h1>
      <p>
        <strong>{copy.yourLabel}</strong> {queueLabel}
      </p>
      {content}
    </section>
  );

  const manualRefreshControl = (
    <>
      <button
        type="button"
        onClick={() => manualRefreshRef.current()}
        disabled={manualRefreshPending}
        aria-busy={manualRefreshPending}
      >
        {manualRefreshPending ? copy.manualRefreshPending : copy.manualRefresh}
      </button>
      {manualRefreshOutcome !== 'idle' ? (
        <p
          role="status"
          aria-atomic="true"
          data-testid="manual-refresh-feedback"
        >
          {manualRefreshOutcome === 'pending'
            ? copy.manualRefreshPending
            : manualRefreshOutcome === 'verified'
              ? copy.manualRefreshVerified
              : copy.manualRefreshFailed}
        </p>
      ) : null}
    </>
  );

  const manualRetryFeedback =
    manualRetryOutcome !== 'idle' ? (
      <p role="status" aria-atomic="true" data-testid="manual-retry-feedback">
        {manualRetryOutcome === 'pending'
          ? copy.manualRetryPending
          : manualRetryOutcome === 'verified'
            ? copy.manualRetryVerified
            : copy.manualRetryFailed}
      </p>
    ) : null;

  const streamGuidance = (
    <div data-testid="guest-stream-connection" aria-live="off">
      {streamConnection === 'connected'
        ? copy.streamConnected
        : streamConnection === 'reconnecting'
          ? copy.streamReconnecting
          : streamConnection === 'fallback'
            ? copy.streamFallback
            : streamConnection === 'recovered'
              ? copy.streamRecovered
              : null}
      {streamAnnouncement !== 'none' ? (
        <p role="status" data-testid="guest-stream-announcement">
          {streamAnnouncement === 'fallback'
            ? copy.streamFallback
            : copy.streamRecovered}
        </p>
      ) : null}
    </div>
  );

  const lastVerifiedStatus = lastVerifiedAt ? (
    <p>
      <strong>{copy.lastVerified}</strong>{' '}
      <time dateTime={lastVerifiedAt.toISOString()}>
        {new Intl.DateTimeFormat(locale === 'ar' ? 'ar-DZ' : 'fr-FR', {
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(lastVerifiedAt)}
      </time>
    </p>
  ) : null;

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
    if (state.data.closureStatus === 'closed') {
      return shell(<ClosedStatus copy={copy} />);
    }
    return shell(
      <>
        <h2>{copy.visitStatus}</h2>
        <p>
          <strong>{copy.status}</strong>{' '}
          {copy.bookingStates[state.data.bookingState] ??
            state.data.bookingState}
        </p>
        {state.data.queueState !== state.data.bookingState ? (
          <p>
            {copy.queueStates[state.data.queueState] ?? state.data.queueState}
          </p>
        ) : null}
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
        {state.data?.pauseStatus === 'paused' ? (
          <PausedStatus copy={copy} />
        ) : state.data?.eta ? (
          <EtaStatus eta={state.data.eta} copy={copy} locale={locale} />
        ) : null}
        {state.data?.pauseStatus !== 'paused' &&
        state.data?.activeConsultationRemainingMinutes !== null &&
        state.data?.activeConsultationRemainingMinutes !== undefined ? (
          <ActiveConsultationStatus
            minutes={state.data.activeConsultationRemainingMinutes}
            copy={copy}
            locale={locale}
          />
        ) : null}
        {checkInState.kind === 'done' ? (
          <p role="status">
            {checkInState.reconciled
              ? copy.checkInAlreadyDone
              : copy.checkInSuccess}
          </p>
        ) : null}
        <div role="status">
          <h2>{state.exhausted ? copy.offline : copy.stale}</h2>
          <p>
            {state.exhausted
              ? copy.offlineBody
              : state.hidden
                ? copy.hiddenBody
                : copy.staleBody}
          </p>
          {state.exhausted ? (
            <button
              type="button"
              onClick={() => manualRetryRef.current()}
              disabled={manualRetryPending}
              aria-busy={manualRetryPending}
            >
              {manualRetryPending ? copy.manualRetryPending : copy.manualRetry}
            </button>
          ) : null}
          {manualRetryFeedback}
        </div>
        {state.data ? lastVerifiedStatus : null}
        {state.data && !state.exhausted ? streamGuidance : null}
        {state.data ? manualRefreshControl : null}
      </>,
    );
  }

  return shell(
    <>
      <p>
        <strong>{copy.status}</strong>{' '}
        {copy.queueStates[state.data.queueState] ?? state.data.queueState}
      </p>
      {state.data.pauseStatus === 'paused' ? (
        <PausedStatus copy={copy} />
      ) : state.data.eta ? (
        <EtaStatus eta={state.data.eta} copy={copy} locale={locale} />
      ) : null}
      {state.data.pauseStatus !== 'paused' &&
      state.data.activeConsultationRemainingMinutes !== null &&
      state.data.activeConsultationRemainingMinutes !== undefined ? (
        <ActiveConsultationStatus
          minutes={state.data.activeConsultationRemainingMinutes}
          copy={copy}
          locale={locale}
        />
      ) : null}
      {lastVerifiedStatus}
      {streamGuidance}
      {manualRefreshControl}
      {manualRetryFeedback}
      {state.data.queueState === 'waiting' || checkInState.kind !== 'idle' ? (
        <div role="status">
          {checkInState.kind === 'done' ? (
            <p>
              {checkInState.reconciled
                ? copy.checkInAlreadyDone
                : copy.checkInSuccess}
            </p>
          ) : (
            <>
              {checkInState.kind === 'rejected' ? (
                <p role="alert">{copy.checkInRejected}</p>
              ) : null}
              {checkInState.kind === 'transient' ? (
                <p role="alert">{copy.checkInTransient}</p>
              ) : null}
              <button
                type="button"
                onClick={() => void submitCheckIn()}
                disabled={checkInState.kind === 'pending'}
              >
                {checkInState.kind === 'pending'
                  ? copy.checkInPending
                  : checkInState.kind === 'transient'
                    ? copy.retry
                    : copy.checkIn}
              </button>
            </>
          )}
        </div>
      ) : null}
    </>,
  );
}
