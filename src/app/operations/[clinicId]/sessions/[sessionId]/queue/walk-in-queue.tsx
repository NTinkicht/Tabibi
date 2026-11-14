'use client';

import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import Link from 'next/link';
import { receptionistCopy } from '@/modules/localization/receptionist';
import { BulkAppointmentNoShowAction } from './BulkAppointmentNoShowAction';
import { SessionBar } from './session-bar';
import { TodayTilesPanel, UndeliveredAlert, WalkInPanel } from './side-panel';
import { useUndeliveredCount } from './use-undelivered-count';
import {
  buildConsoleView,
  formatLastAction,
  todayTiles,
  type ConsoleEntry,
} from '@/modules/receptionist-dashboard/console-view';
import { QueueRows, ServingCards, type PanelAction } from './console-regions';
import { useCallback, useEffect, useRef, useState } from 'react';

type EntryState =
  | 'waiting'
  | 'checked_in'
  | 'called'
  | 'in_consultation'
  | 'completed'
  | 'cancelled'
  | 'no_show';
type WaitingEntry = {
  id: string;
  sessionId: string;
  state: EntryState;
  registrationOrder: number;
  publicDisplayLabel: string;
  privateDisplayName: string;
  preferredLocale: 'ar' | 'fr';
  hasContact: boolean;
  eligibilityOrder?: number | null;
  priorityOrder?: number | null;
};

type WalkInRegistration = {
  patient: {
    privateDisplayName: string;
    preferredLocale: 'ar' | 'fr';
    hasContact: boolean;
  };
  entry: {
    id: string;
    sessionId: string;
    state: 'waiting';
    registrationOrder: number;
    publicDisplayLabel: string;
  };
};
type DashboardSession = {
  doctorDisplayName: string;
  startsAt: string;
  endsAt: string;
  status: 'planned' | 'open' | 'paused' | 'closed' | 'cancelled';
  declaredDelayMinutes: number | null;
  delayVersion: number;
  queueOrderVersion: number;
};

function key() {
  return crypto.randomUUID();
}

export function WalkInQueue({
  clinicId,
  sessionId,
  initialLocale = 'ar',
}: {
  clinicId: string;
  sessionId: string;
  initialLocale?: 'ar' | 'fr';
}) {
  const [locale, setLocale] = useState<'ar' | 'fr'>(initialLocale);
  const t = receptionistCopy[locale];
  const [entries, setEntries] = useState<WaitingEntry[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [pendingEntry, setPendingEntry] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState('');
  const [queueOrderVersion, setQueueOrderVersion] = useState(0);
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const [timezone, setTimezone] = useState('UTC');
  const undelivered = useUndeliveredCount(clinicId);
  const pendingKeysRef = useRef(new Map<string, string>());
  const loadRequestRef = useRef(0);
  const hasSnapshotRef = useRef(false);
  const lastLoadFailedRef = useRef(false);

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/dashboard`,
        { cache: 'no-store' },
      );
      const body = (await response.json()) as {
        entries?: WaitingEntry[];
        queueOrderVersion?: number;
        session?: DashboardSession;
        generatedAt?: string;
        timezone?: string;
        refreshAfterSeconds?: number;
        message?: string;
      };
      if (!response.ok || !body.entries || !body.session || !body.generatedAt)
        throw new Error(body.message);
      if (requestId !== loadRequestRef.current) return;
      setEntries(body.entries);
      setSession(body.session);
      if (body.timezone) setTimezone(body.timezone);
      setQueueOrderVersion(body.session.queueOrderVersion);
      setRefreshedAt(new Date(body.generatedAt));
      hasSnapshotRef.current = true;
      lastLoadFailedRef.current = false;
      setMessage('');
      setStale(false);
      setState('ready');
    } catch (error) {
      if (requestId !== loadRequestRef.current) return;
      const nextMessage =
        error instanceof Error && error.message ? error.message : t.error;
      if (hasSnapshotRef.current) {
        lastLoadFailedRef.current = true;
        setStale(true);
        setState('ready');
        setMessage(nextMessage);
        return;
      }
      setState('error');
      setMessage(nextMessage);
    }
  }, [clinicId, sessionId, t.error]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const poll = window.setInterval(() => void load(), 30_000);
    const staleTimer = window.setInterval(() => {
      setStale(
        lastLoadFailedRef.current ||
          refreshedAt === null ||
          Date.now() - refreshedAt.getTime() > 45_000,
      );
    }, 5_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(staleTimer);
    };
  }, [load, refreshedAt]);

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      privateDisplayName: String(data.get('privateDisplayName') ?? '').trim(),
      contactPhone: String(data.get('contactPhone') ?? '').trim() || null,
      contactEmail: String(data.get('contactEmail') ?? '').trim() || null,
      preferredLocale: String(data.get('preferredLocale') ?? 'ar') as
        | 'ar'
        | 'fr',
    };
    const presentNow = data.get('presentNow') !== null;
    const opId = JSON.stringify(payload);
    let idempotencyKey = pendingKeysRef.current.get(opId);
    if (!idempotencyKey) {
      idempotencyKey = key();
      pendingKeysRef.current.set(opId, idempotencyKey);
    }
    setPending(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/queue`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(payload),
        },
      );
      pendingKeysRef.current.delete(opId);
      const body = (await response.json()) as {
        registration?: WalkInRegistration;
        message?: string;
      };
      if (!response.ok || !body.registration) throw new Error(body.message);
      const registration = body.registration;
      const registeredEntry: WaitingEntry = {
        ...registration.entry,
        privateDisplayName: registration.patient.privateDisplayName,
        preferredLocale: registration.patient.preferredLocale,
        hasContact: registration.patient.hasContact,
      };
      setEntries((items) =>
        [
          ...items.filter((item) => item.id !== registeredEntry.id),
          registeredEntry,
        ].sort(
          (left, right) => left.registrationOrder - right.registrationOrder,
        ),
      );
      setState('ready');
      form.reset();
      if (presentNow) {
        // Two-step: the entry exists as `waiting`; a failed check-in leaves it
        // there and says so instead of rolling the registration back.
        await command(
          registeredEntry,
          'check_in',
          undefined,
          t.presentNowFailed,
        );
      } else {
        // Not awaited on purpose: the registered entry was already merged into
        // `entries` from the POST response above, so this is a background
        // reconcile and setState('ready')/form.reset() do not depend on it.
        void load();
      }
    } catch (error) {
      setMessage(
        error instanceof Error && error.message ? error.message : t.queueError,
      );
    } finally {
      setPending(false);
    }
  }

  function reload() {
    setMessage('');
    if (!hasSnapshotRef.current) setState('loading');
    void load();
  }

  async function command(
    entry: WaitingEntry,
    commandName:
      | 'check_in'
      | 'call'
      | 'no_show'
      | 'cancel'
      | 'start_consultation'
      | 'complete_consultation',
    panelReason?: string,
    failureMessage?: string,
  ) {
    let reason: string | undefined = panelReason;
    let cancellationSource: 'patient' | 'clinic' | undefined;
    if (
      (commandName === 'no_show' || commandName === 'cancel') &&
      reason === undefined
    ) {
      reason = window.prompt(t.queueReason)?.trim();
      if (!reason) return;
    }
    if (commandName === 'cancel') {
      cancellationSource = window.confirm(t.patientCancellation)
        ? 'patient'
        : 'clinic';
    }
    const operation = `${entry.id}:${commandName}:${reason ?? ''}:${cancellationSource ?? ''}`;
    let idempotencyKey = pendingKeysRef.current.get(operation);
    if (!idempotencyKey) {
      idempotencyKey = key();
      pendingKeysRef.current.set(operation, idempotencyKey);
    }
    setPendingEntry(entry.id);
    setMessage('');
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/queue/${entry.id}/commands`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            command: commandName,
            reason,
            cancellationSource,
          }),
        },
      );
      const body = (await response.json()) as {
        entry?: WaitingEntry;
        message?: string;
      };
      if (!response.ok || !body.entry) throw new Error(body.message);
      pendingKeysRef.current.delete(operation);
      setLastAction(
        formatLastAction(
          t.lastAction,
          entry,
          t.queueStatuses[body.entry.state] ?? '',
        ),
      );
      await load();
    } catch (error) {
      setMessage(
        failureMessage ??
          (error instanceof Error && error.message
            ? error.message
            : t.queueError),
      );
    } finally {
      setPendingEntry(null);
    }
  }

  /** Prioritise = reorder to position 1 of the priority cohort, with a reason. */
  async function prioritise(entry: WaitingEntry, reason: string) {
    const targetPosition = 1;
    const operation = `${entry.id}:reorder:${targetPosition}:${queueOrderVersion}:${reason}`;
    const idempotencyKey = pendingKeysRef.current.get(operation) ?? key();
    pendingKeysRef.current.set(operation, idempotencyKey);
    setPendingEntry(entry.id);
    setMessage('');
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/queue/${entry.id}/reorder`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            targetPosition,
            expectedVersion: queueOrderVersion,
            reason,
          }),
        },
      );
      const body = (await response.json()) as {
        queueOrderVersion?: number;
        orderedEntryIds?: string[];
        message?: string;
      };
      if (
        !response.ok ||
        !body.orderedEntryIds ||
        body.queueOrderVersion === undefined
      )
        throw new Error(body.message);
      pendingKeysRef.current.delete(operation);
      setLastAction(formatLastAction(t.lastAction, entry, t.priorityBadge));
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error && error.message ? error.message : t.queueError,
      );
      await load();
    } finally {
      setPendingEntry(null);
    }
  }

  async function sessionMutation(
    path: 'commands' | 'delay',
    operation: string,
    payload: object,
  ) {
    let idempotencyKey = pendingKeysRef.current.get(operation);
    if (!idempotencyKey) {
      idempotencyKey = key();
      pendingKeysRef.current.set(operation, idempotencyKey);
    }
    setPending(true);
    setMessage('');
    let failure = '';
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json()) as {
        session?: unknown;
        message?: string;
      };
      if (!response.ok || !body.session) throw new Error(body.message);
      pendingKeysRef.current.delete(operation);
    } catch (error) {
      failure =
        error instanceof Error && error.message ? error.message : t.queueError;
    }
    try {
      await load();
    } finally {
      // Stay busy until the refreshed snapshot is applied, and keep the
      // mutation error visible (load() clears the message on success).
      if (failure) setMessage(failure);
      setPending(false);
    }
  }

  function sessionCommand(commandName: 'pause' | 'resume' | 'close') {
    void sessionMutation('commands', `session:${commandName}`, {
      command: commandName,
    });
  }

  function setDelay(minutes: number) {
    if (!session) return;
    const payload =
      minutes === 0
        ? { command: 'clear_delay', expectedVersion: session.delayVersion }
        : {
            command:
              session.declaredDelayMinutes === null
                ? 'declare_delay'
                : 'update_delay',
            minutes,
            expectedVersion: session.delayVersion,
          };
    void sessionMutation(
      'delay',
      `session:delay:${session.delayVersion}:${minutes}`,
      payload,
    );
  }

  const consoleView = session
    ? buildConsoleView(entries as unknown as ConsoleEntry[], session.status)
    : null;
  const nextCallable = consoleView?.nextCallable ?? null;
  function callNext() {
    const target = entries.find((entry) => entry.id === nextCallable?.id);
    if (target) void command(target, 'call');
  }

  function panelAction(
    entry: ConsoleEntry,
    action: PanelAction,
    reason: string,
  ) {
    const target = entries.find((item) => item.id === entry.id);
    if (!target) return;
    if (action === 'prioritise') void prioritise(target, reason);
    else void command(target, action, reason);
  }
  const regions = {
    t,
    locale,
    timezone,
    busy: pending || pendingEntry !== null || stale,
    pendingEntryId: pendingEntry,
    onPrimary: (entry: ConsoleEntry, name: Parameters<typeof command>[1]) => {
      const target = entries.find((item) => item.id === entry.id);
      if (target) void command(target, name);
    },
    onPanel: panelAction,
  };

  return (
    <main className="desk" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <DocumentLocaleSync locale={locale} />
      <header className="deskHeader">
        <div>
          <span className="eyebrow">TABIBI · WALK-IN</span>
          <h1>{t.queueTitle}</h1>
          <p>{t.queueSubtitle}</p>
        </div>
        <button
          className="locale"
          onClick={() => setLocale(locale === 'ar' ? 'fr' : 'ar')}
        >
          {locale === 'ar' ? 'Français' : 'العربية'}
        </button>
      </header>

      <div className="queueToolbar">
        <Link
          className="secondaryLink"
          href={`/operations/${clinicId}?locale=${locale}`}
        >
          {t.backSessions}
        </Link>
        <button className="locale" onClick={reload}>
          {t.reload}
        </button>
      </div>

      {session && (
        <section className="dashboardSummary" aria-label={t.operatingView}>
          <div>
            <small>{t.doctorLabel}</small>
            <strong>{session.doctorDisplayName}</strong>
          </div>
          <div>
            <small>{t.sessionState}</small>
            <strong>{t.statuses[session.status]}</strong>
          </div>
          <div>
            <small>{t.delay}</small>
            <strong>
              {session.declaredDelayMinutes
                ? `${session.declaredDelayMinutes} ${t.minutes}`
                : t.noDelay}
            </strong>
          </div>
          <div className={stale ? 'staleSnapshot' : ''}>
            <small>{stale ? t.stale : t.lastRefresh}</small>
            <strong>
              {refreshedAt?.toLocaleTimeString(
                locale === 'ar' ? 'ar-DZ' : 'fr-DZ',
                { hour: '2-digit', minute: '2-digit' },
              )}
            </strong>
          </div>
        </section>
      )}

      {session && consoleView && (
        <SessionBar
          t={t}
          status={session.status}
          declaredDelayMinutes={session.declaredDelayMinutes}
          nextCallable={nextCallable}
          callNextEnabled={
            consoleView.callNextEnabled && !stale && pendingEntry === null
          }
          busy={pending || pendingEntry !== null}
          onCallNext={callNext}
          onDelay={setDelay}
          onSessionCommand={sessionCommand}
        />
      )}

      {message && (
        <div className="alert" role="alert">
          {message}
        </div>
      )}

      <div className="consoleLayout">
        <div className="consoleMain">
          {state === 'loading' && (
            <div className="state" aria-live="polite">
              <span className="spinner" />
              {t.queueLoading}
            </div>
          )}
          {state === 'error' && !message && (
            <div className="state error">{t.queueError}</div>
          )}
          {state === 'ready' && entries.length === 0 && (
            <div className="state">
              <span className="emptyIcon">○</span>
              <p>{t.noWaiting}</p>
            </div>
          )}
          {state === 'ready' && consoleView && (
            <>
              {lastAction && (
                <div className="lastAction" role="status">
                  {lastAction}
                </div>
              )}
              <ServingCards rows={consoleView.serving} h={regions} />
              {consoleView.queue.length > 0 && (
                <QueueRows
                  rows={consoleView.queue}
                  arrived={consoleView.arrivedCount}
                  notArrived={consoleView.notArrivedCount}
                  h={regions}
                />
              )}
            </>
          )}
        </div>
        <aside className="consoleSide" aria-label={t.sidePanelLabel}>
          <WalkInPanel
            t={t}
            locale={locale}
            pending={pending}
            onSubmit={(event) => void register(event)}
          />
          {consoleView && <TodayTilesPanel t={t} tiles={todayTiles(entries)} />}
          <UndeliveredAlert
            t={t}
            clinicId={clinicId}
            locale={locale}
            count={undelivered}
          />
          {state === 'ready' &&
            session &&
            !['closed', 'cancelled'].includes(session.status) &&
            entries.some((entry) => entry.state === 'waiting') && (
              <BulkAppointmentNoShowAction
                clinicId={clinicId}
                sessionId={sessionId}
                locale={locale}
                enabled={!stale && pendingEntry === null && !pending}
                onResolved={load}
              />
            )}
        </aside>
      </div>
    </main>
  );
}
