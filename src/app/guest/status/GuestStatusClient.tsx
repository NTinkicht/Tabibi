'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Chip, type ChipTone } from '../../ui';
import './guest-status.css';
import { formatUpdatedAgo, updatedAgo } from './updated-ago';

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
  estimateExplainerLink: string;
  estimateExplainerNewTab: string;
  queueHelpLink: string;
  queueStates: Record<string, string>;
  sessionStates: Record<string, string>;
  terminalStates: Record<string, string>;
  provisionalNote: string;
  reportArrival: string;
  stayNearReception: string;
  pausedTitle: string;
  pausedBody: string;
  patientsAheadSuffix: string;
  yourTurn: string;
  goToDeskWithNumber: string;
  noLongerUpdates: string;
  terminalBodies: Record<string, string>;
  helpLink: string;
  privacyFooter: string;
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
    estimateExplainerLink: 'Why estimates can change',
    estimateExplainerNewTab: 'opens in a new tab',
    queueHelpLink: 'What to do while waiting',
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
    provisionalNote:
      'Your position is provisional until you check in at the clinic.',
    reportArrival: 'Tell reception when you arrive.',
    stayNearReception: 'Please stay near reception.',
    pausedTitle: 'Consultations are paused',
    pausedBody:
      'Your place is kept. Your estimate is suspended during the pause.',
    patientsAheadSuffix: 'patients ahead of you',
    yourTurn: 'It is your turn',
    goToDeskWithNumber: 'Go to reception and give your number:',
    noLongerUpdates: 'This page no longer updates.',
    terminalBodies: {
      completed: 'Your visit is finished.',
      cancelled: 'Your appointment was cancelled.',
      no_show: 'You were marked absent. Please contact reception.',
      closed: 'The clinic session is closed.',
    },
    helpLink: 'Help',
    privacyFooter:
      'This page shows no name, phone number, doctor or clinic identifier.',
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
    estimateExplainerLink: 'Pourquoi ces estimations changent',
    estimateExplainerNewTab: 's’ouvre dans un nouvel onglet',
    queueHelpLink: 'Que faire pendant l’attente',
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
    provisionalNote:
      'Votre position est provisoire tant que vous n’êtes pas enregistré(e) à la clinique.',
    reportArrival: 'Signalez votre arrivée à l’accueil.',
    stayNearReception: 'Merci de rester près de l’accueil.',
    pausedTitle: 'Consultations suspendues',
    pausedBody:
      'Votre place est conservée. L’estimation est suspendue pendant la pause.',
    patientsAheadSuffix: 'patients avant vous',
    yourTurn: 'C’est votre tour',
    goToDeskWithNumber: 'Présentez-vous à l’accueil avec votre numéro :',
    noLongerUpdates: 'Cette page ne se met plus à jour.',
    terminalBodies: {
      completed: 'Votre visite est terminée.',
      cancelled: 'Votre rendez-vous a été annulé.',
      no_show: 'Vous avez été marqué(e) absent(e). Contactez l’accueil.',
      closed: 'La session de la clinique est fermée.',
    },
    helpLink: 'Aide',
    privacyFooter:
      'Cette page n’affiche ni nom, ni téléphone, ni médecin, ni identifiant de clinique.',
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
    estimateExplainerLink: 'لماذا تتغير هذه التقديرات',
    estimateExplainerNewTab: 'يُفتح في علامة تبويب جديدة',
    queueHelpLink: 'ماذا تفعل أثناء الانتظار',
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
    provisionalNote: 'موقعك مؤقت إلى أن تسجّل وصولك إلى العيادة.',
    reportArrival: 'أبلغ الاستقبال عند وصولك.',
    stayNearReception: 'يرجى البقاء قرب الاستقبال.',
    pausedTitle: 'الاستشارات متوقفة',
    pausedBody: 'مكانك محفوظ. التقدير متوقف خلال فترة التوقف.',
    patientsAheadSuffix: 'مرضى قبلك',
    yourTurn: 'حان دورك',
    goToDeskWithNumber: 'توجّه إلى الاستقبال مع رقمك:',
    noLongerUpdates: 'لم تعد هذه الصفحة تتحدّث.',
    terminalBodies: {
      completed: 'انتهت زيارتك.',
      cancelled: 'تم إلغاء موعدك.',
      no_show: 'تم تسجيلك غائبًا. يرجى الاتصال بالاستقبال.',
      closed: 'جلسة العيادة مغلقة.',
    },
    helpLink: 'مساعدة',
    privacyFooter:
      'لا تعرض هذه الصفحة اسمًا أو هاتفًا أو طبيبًا أو معرّف عيادة.',
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

/** Ticking relative age of the snapshot; the 5 s tick avoids per-second re-render churn. */
function UpdatedAgoText({
  generatedAt,
  locale,
}: {
  generatedAt: string;
  locale: SupportedLocale;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(tick);
  }, [generatedAt]);
  const age = updatedAgo(generatedAt, nowMs);
  if (!age) return null;
  return <>{formatUpdatedAgo(age, locale)}</>;
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

  const shell = (content: React.ReactNode, chip?: React.ReactNode) => (
    <section
      lang={locale}
      dir={direction}
      aria-live="polite"
      className="gs-page"
    >
      <header className="gs-header">
        <h1>{copy.title}</h1>
        {chip}
      </header>
      <p className="gs-subtitle">{copy.subtitle}</p>
      {content}
      <footer className="gs-footer">
        <p>
          <a href="/guest/queue-next-steps">{copy.queueHelpLink}</a>
        </p>
        <p>
          <a href="/guest/help">{copy.helpLink}</a>
        </p>
        <p>
          <small>{copy.privacyFooter}</small>
        </p>
      </footer>
    </section>
  );

  if (state.kind === 'loading')
    return shell(<p className="gs-card">{copy.loading}</p>);

  if (state.kind === 'signed_out') {
    return shell(
      <div className="gs-card">
        <h2>{copy.accessUnavailable}</h2>
        <p>{copy.accessUnavailableBody}</p>
      </div>,
    );
  }

  if (state.kind === 'error') {
    return shell(
      <div className="gs-card">
        <h2>{copy.statusUnavailable}</h2>
        <p>{copy.statusUnavailableBody}</p>
      </div>,
    );
  }

  if (state.kind === 'terminal') {
    const finalStatus = state.snapshot.finalStatus;
    return shell(
      <div className="gs-card" data-outcome={finalStatus}>
        <h2>{copy.visitStatus}</h2>
        <p>{copy.terminalStates[finalStatus] ?? finalStatus}</p>
        {copy.terminalBodies[finalStatus] ? (
          <p>{copy.terminalBodies[finalStatus]}</p>
        ) : null}
        <p>
          <small>{copy.noLongerUpdates}</small>
        </p>
      </div>,
    );
  }

  const { snapshot } = state;
  const sessionPaused = snapshot.session.status === 'paused';
  const called = snapshot.queueState === 'called';
  const chipTone: ChipTone = called
    ? 'called'
    : snapshot.queueState === 'in_consultation'
      ? 'active'
      : sessionPaused
        ? 'warning'
        : snapshot.positionKind === 'live'
          ? 'arrived'
          : 'neutral';
  const live =
    snapshot.positionKind === 'live' && snapshot.patientsAhead !== null;
  return shell(
    <>
      <div className="gs-card gs-ticket">
        <p>
          <strong>{copy.yourLabel}</strong>{' '}
          <bdi className="gs-ticket-code">{snapshot.publicDisplayLabel}</bdi>
        </p>
      </div>
      {called ? (
        <div className="gs-panel gs-panel--called" role="status">
          <h2>{copy.yourTurn}</h2>
          <p>
            {copy.goToDeskWithNumber}{' '}
            <bdi className="gs-ticket-code">{snapshot.publicDisplayLabel}</bdi>
          </p>
        </div>
      ) : sessionPaused ? (
        <div className="gs-panel gs-panel--paused" role="status">
          <h2>{copy.pausedTitle}</h2>
          <p>{copy.pausedBody}</p>
        </div>
      ) : null}
      <div className="gs-card">
        {snapshot.session.status !== 'open' ? (
          <p>
            <strong>{copy.sessionState}</strong>{' '}
            {copy.sessionStates[snapshot.session.status] ??
              snapshot.session.status}
          </p>
        ) : null}
        {live ? (
          <>
            <p className="gs-ahead">
              <strong>{copy.patientsAhead}</strong> {snapshot.patientsAhead}
            </p>
            <p>
              <small>{copy.patientsAheadSuffix}</small>
            </p>
            <p>{copy.stayNearReception}</p>
          </>
        ) : snapshot.arrivalWindow ? (
          <>
            <p>
              <strong>{copy.arrivalWindow}</strong>{' '}
              <bdi>
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
              </bdi>
            </p>
            <p>{copy.provisionalNote}</p>
            <p>{copy.reportArrival}</p>
          </>
        ) : null}
        {snapshot.session.declaredDelayMinutes !== null ? (
          <p className="gs-delay">
            <strong>{copy.clinicDelay}</strong>{' '}
            {snapshot.session.declaredDelayMinutes} {copy.minute}
          </p>
        ) : null}
        <p>
          <a
            href={`/guest/eta-explained?lang=${locale === 'ar' ? 'ar' : 'fr'}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-describedby="tabibi-guest-status-eta-explainer-hint"
          >
            {copy.estimateExplainerLink}
          </a>{' '}
          <small id="tabibi-guest-status-eta-explainer-hint">
            ({copy.estimateExplainerNewTab})
          </small>
        </p>
        <p>
          <small data-testid="guest-status-updated">
            <UpdatedAgoText
              generatedAt={snapshot.generatedAt}
              locale={locale}
            />
          </small>
        </p>
      </div>
    </>,
    <Chip tone={chipTone}>
      {copy.queueStates[snapshot.queueState] ?? snapshot.queueState}
    </Chip>,
  );
}
