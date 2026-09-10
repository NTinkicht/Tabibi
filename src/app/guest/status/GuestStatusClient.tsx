'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

const NORMAL_POLL_MS = 30_000;
const MAX_RETRY_AFTER_SECONDS = 300;

type SupportedLocale = 'en' | 'fr' | 'ar';

type ActiveSnapshot = {
  generatedAt: string;
  terminal: false;
  publicDisplayLabel: string;
  queueState: string;
  clinicTimezone: string;
  patientsAhead: number | null;
  positionKind: 'live' | 'provisional';
  arrivalWindow: {
    earliestAt: string;
    latestAt: string;
    uncertaintyMinutes: number;
  } | null;
  session: {
    status: string;
    declaredDelayMinutes: number | null;
    delayVersion?: number;
    queueOrderVersion?: number;
  };
};

type TerminalSnapshot = {
  generatedAt: string;
  terminal: true;
  finalStatus: string;
};

type GuestStatusSnapshot = ActiveSnapshot | TerminalSnapshot;

type ViewState =
  | { kind: 'loading' }
  | { kind: 'active'; snapshot: ActiveSnapshot }
  | { kind: 'terminal'; snapshot: TerminalSnapshot }
  | { kind: 'signed_out' }
  | { kind: 'error' };

type Copy = {
  title: string;
  subtitle: string;
  loading: string;
  accessUnavailable: string;
  accessUnavailableBody: string;
  statusUnavailable: string;
  statusUnavailableBody: string;
  visitStatus: string;
  yourLabel: string;
  status: string;
  patientsAhead: string;
  arrivalWindow: string;
  clinicDelay: string;
  sessionState: string;
  minute: string;
  updated: string;
  queueStates: Record<string, string>;
  sessionStates: Record<string, string>;
  terminalStates: Record<string, string>;
};

const COPY: Record<SupportedLocale, Copy> = {
  en: {
    title: 'Tabibi',
    subtitle: 'Live queue status',
    loading: 'Loading your queue status…',
    accessUnavailable: 'Guest access unavailable',
    accessUnavailableBody:
      'Your secure guest session has expired or is no longer valid.',
    statusUnavailable: 'Status temporarily unavailable',
    statusUnavailableBody:
      'We will retry automatically. No action is required.',
    visitStatus: 'Visit status',
    yourLabel: 'Your label:',
    status: 'Status:',
    patientsAhead: 'Patients ahead:',
    arrivalWindow: 'Expected arrival window:',
    clinicDelay: 'Declared clinic delay:',
    sessionState: 'Clinic session:',
    minute: 'min',
    updated: 'Updated',
    queueStates: {
      waiting: 'waiting',
      checked_in: 'checked in',
      called: 'called',
      in_consultation: 'in consultation',
    },
    sessionStates: {
      planned: 'not started yet',
      open: 'open',
      paused: 'temporarily paused',
    },
    terminalStates: {
      completed: 'completed',
      cancelled: 'cancelled',
      no_show: 'no show',
      closed: 'closed',
    },
  },
  fr: {
    title: 'Tabibi',
    subtitle: 'Statut de la file d’attente en direct',
    loading: 'Chargement de votre statut dans la file…',
    accessUnavailable: 'Accès invité indisponible',
    accessUnavailableBody:
      "Votre session sécurisée a expiré ou n'est plus valide.",
    statusUnavailable: 'Statut temporairement indisponible',
    statusUnavailableBody:
      'Nous réessaierons automatiquement. Aucune action n’est requise.',
    visitStatus: 'Statut de la visite',
    yourLabel: 'Votre numéro :',
    status: 'Statut :',
    patientsAhead: 'Patients avant vous :',
    arrivalWindow: 'Créneau d’arrivée estimé :',
    clinicDelay: 'Retard déclaré de la clinique :',
    sessionState: 'Session de la clinique :',
    minute: 'min',
    updated: 'Mis à jour',
    queueStates: {
      waiting: 'en attente',
      checked_in: 'enregistré',
      called: 'appelé',
      in_consultation: 'en consultation',
    },
    sessionStates: {
      planned: 'pas encore commencée',
      open: 'ouverte',
      paused: 'temporairement en pause',
    },
    terminalStates: {
      completed: 'terminé',
      cancelled: 'annulé',
      no_show: 'absent',
      closed: 'fermée',
    },
  },
  ar: {
    title: 'طبيبي',
    subtitle: 'حالة قائمة الانتظار مباشرة',
    loading: 'جارٍ تحميل حالة الانتظار…',
    accessUnavailable: 'وصول الضيف غير متاح',
    accessUnavailableBody: 'انتهت جلسة الضيف الآمنة أو لم تعد صالحة.',
    statusUnavailable: 'الحالة غير متاحة مؤقتًا',
    statusUnavailableBody: 'سنحاول مرة أخرى تلقائيًا. لا يلزم اتخاذ إجراء.',
    visitStatus: 'حالة الزيارة',
    yourLabel: 'رقمك:',
    status: 'الحالة:',
    patientsAhead: 'المرضى قبلك:',
    arrivalWindow: 'نافذة الوصول المتوقعة:',
    clinicDelay: 'التأخير المعلن للعيادة:',
    sessionState: 'جلسة العيادة:',
    minute: 'دقيقة',
    updated: 'آخر تحديث',
    queueStates: {
      waiting: 'في الانتظار',
      checked_in: 'تم تسجيل الوصول',
      called: 'تم النداء',
      in_consultation: 'في الاستشارة',
    },
    sessionStates: {
      planned: 'لم تبدأ بعد',
      open: 'مفتوحة',
      paused: 'متوقفة مؤقتًا',
    },
    terminalStates: {
      completed: 'اكتملت',
      cancelled: 'ألغيت',
      no_show: 'لم يحضر',
      closed: 'مغلقة',
    },
  },
};

const INTL_LOCALES: Record<SupportedLocale, string> = {
  en: 'en-DZ',
  fr: 'fr-DZ',
  ar: 'ar-DZ',
};

/** Return a bounded retry delay for a throttled response. */
function retryDelay(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return NORMAL_POLL_MS;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1_000;
}

/** Format a server timestamp in the clinic timezone, never the device timezone. */
function formatTime(
  value: string,
  locale: SupportedLocale,
  clinicTimezone: string,
): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: clinicTimezone,
  }).format(new Date(value));
}

/** Detect one of the guest UI locales supported by this bounded status view. */
function detectGuestLocale(): SupportedLocale {
  if (typeof navigator === 'undefined') return 'en';
  const locale = navigator.language.toLowerCase();
  if (locale.startsWith('ar')) return 'ar';
  if (locale.startsWith('fr')) return 'fr';
  return 'en';
}

/** Locale is stable for a mounted guest status page. */
function subscribeToGuestLocale(): () => void {
  return () => undefined;
}

/** Render SSE-first guest status while retaining bounded polling as fallback. */
export function GuestStatusClient() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const locale = useSyncExternalStore<SupportedLocale>(
    subscribeToGuestLocale,
    detectGuestLocale,
    () => 'en',
  );
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const copy = COPY[locale];
  const direction = locale === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    let cancelled = false;
    let pollGeneration = 0;
    let pollAbortController: AbortController | null = null;

    const clearScheduledPoll = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };

    const invalidatePoll = () => {
      pollGeneration += 1;
      pollAbortController?.abort();
      pollAbortController = null;
    };

    const closeStream = () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };

    const applySnapshot = (snapshot: GuestStatusSnapshot): boolean => {
      if (snapshot.terminal) {
        setState({ kind: 'terminal', snapshot });
        clearScheduledPoll();
        closeStream();
        return true;
      }
      setState({ kind: 'active', snapshot });
      return false;
    };

    const schedule = (delay: number, poll: () => Promise<void>) => {
      clearScheduledPoll();
      timeoutRef.current = setTimeout(() => void poll(), delay);
    };

    const connectStream = (poll: () => Promise<void>) => {
      if (
        cancelled ||
        typeof EventSource === 'undefined' ||
        document.visibilityState === 'hidden'
      ) {
        schedule(NORMAL_POLL_MS, poll);
        return;
      }

      closeStream();
      const source = new EventSource('/api/guest/status/stream');
      eventSourceRef.current = source;

      source.addEventListener('change', () => {
        if (cancelled || eventSourceRef.current !== source) return;
        closeStream();
        void poll();
      });

      source.onerror = () => {
        if (cancelled || eventSourceRef.current !== source) return;
        closeStream();
        schedule(NORMAL_POLL_MS, poll);
      };
    };

    const poll = async () => {
      clearScheduledPoll();
      invalidatePoll();
      const generation = pollGeneration;
      const controller = new AbortController();
      pollAbortController = controller;
      const isCurrent = () =>
        !cancelled &&
        generation === pollGeneration &&
        !controller.signal.aborted;

      try {
        const response = await fetch('/api/guest/status', {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!isCurrent()) return;

        if (response.status === 401) {
          setState({ kind: 'signed_out' });
          clearScheduledPoll();
          closeStream();
          return;
        }
        if (response.status === 429) {
          schedule(retryDelay(response), poll);
          return;
        }
        if (!response.ok) {
          setState({ kind: 'error' });
          schedule(NORMAL_POLL_MS, poll);
          return;
        }

        const snapshot = (await response.json()) as GuestStatusSnapshot;
        if (!isCurrent()) return;
        if (applySnapshot(snapshot)) return;
        if (!isCurrent()) return;
        connectStream(poll);
      } catch (error) {
        if (
          !isCurrent() ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return;
        }
        setState({ kind: 'error' });
        schedule(NORMAL_POLL_MS, poll);
      } finally {
        if (pollAbortController === controller) pollAbortController = null;
      }
    };

    const handleVisibilityChange = () => {
      if (cancelled) return;
      invalidatePoll();
      if (document.visibilityState === 'hidden') {
        closeStream();
        schedule(NORMAL_POLL_MS, poll);
        return;
      }

      clearScheduledPoll();
      closeStream();
      void poll();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    void poll();
    return () => {
      cancelled = true;
      invalidatePoll();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearScheduledPoll();
      closeStream();
    };
  }, []);

  const shell = (content: React.ReactNode) => (
    <section lang={locale} dir={direction} aria-live="polite">
      <h1>{copy.title}</h1>
      <p>{copy.subtitle}</p>
      {content}
    </section>
  );

  if (state.kind === 'loading') return shell(<p>{copy.loading}</p>);

  if (state.kind === 'signed_out') {
    return shell(
      <>
        <h2>{copy.accessUnavailable}</h2>
        <p>{copy.accessUnavailableBody}</p>
      </>,
    );
  }

  if (state.kind === 'error') {
    return shell(
      <>
        <h2>{copy.statusUnavailable}</h2>
        <p>{copy.statusUnavailableBody}</p>
      </>,
    );
  }

  if (state.kind === 'terminal') {
    return shell(
      <>
        <h2>{copy.visitStatus}</h2>
        <p>
          {copy.terminalStates[state.snapshot.finalStatus] ??
            state.snapshot.finalStatus}
        </p>
      </>,
    );
  }

  const { snapshot } = state;
  return shell(
    <>
      <p>
        <strong>{copy.yourLabel}</strong> {snapshot.publicDisplayLabel}
      </p>
      <p>
        <strong>{copy.status}</strong>{' '}
        {copy.queueStates[snapshot.queueState] ?? snapshot.queueState}
      </p>
      {snapshot.session.status !== 'open' ? (
        <p>
          <strong>{copy.sessionState}</strong>{' '}
          {copy.sessionStates[snapshot.session.status] ??
            snapshot.session.status}
        </p>
      ) : null}
      {snapshot.positionKind === 'live' && snapshot.patientsAhead !== null ? (
        <p>
          <strong>{copy.patientsAhead}</strong> {snapshot.patientsAhead}
        </p>
      ) : snapshot.arrivalWindow ? (
        <p>
          <strong>{copy.arrivalWindow}</strong>{' '}
          {formatTime(
            snapshot.arrivalWindow.earliestAt,
            locale,
            snapshot.clinicTimezone,
          )}
          –
          {formatTime(
            snapshot.arrivalWindow.latestAt,
            locale,
            snapshot.clinicTimezone,
          )}
        </p>
      ) : null}
      {snapshot.session.declaredDelayMinutes !== null ? (
        <p>
          <strong>{copy.clinicDelay}</strong>{' '}
          {snapshot.session.declaredDelayMinutes} {copy.minute}
        </p>
      ) : null}
      <p>
        <small>
          {copy.updated}{' '}
          {formatTime(snapshot.generatedAt, locale, snapshot.clinicTimezone)}
        </small>
      </p>
    </>,
  );
}
