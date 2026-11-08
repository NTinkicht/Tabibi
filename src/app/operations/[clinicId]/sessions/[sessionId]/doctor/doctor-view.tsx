'use client';

import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import { doctorCopy } from '@/modules/localization/doctor';
import { receptionistCopy } from '@/modules/localization/receptionist';
import {
  CONSOLE_DELAY_MAX_MINUTES,
  formatWaitRange,
  steppedDelay,
  type ConsoleEntry,
} from '@/modules/receptionist-dashboard/console-view';
import {
  DOCTOR_NEXT_LIST_LIMIT,
  buildDoctorView,
} from '@/modules/receptionist-dashboard/doctor-view';
import { useCallback, useEffect, useRef, useState } from 'react';

type SessionStatus = 'planned' | 'open' | 'paused' | 'closed' | 'cancelled';
type DashboardSession = {
  doctorDisplayName: string;
  status: SessionStatus;
  declaredDelayMinutes: number | null;
  delayVersion: number;
};

const key = () => crypto.randomUUID();

export function DoctorView({
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
  const d = doctorCopy[locale];
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const [reason, setReason] = useState('');
  const keysRef = useRef(new Map<string, string>());
  const loadRef = useRef(0);
  const base = `/api/clinics/${clinicId}/sessions/${sessionId}`;

  const load = useCallback(async (): Promise<string> => {
    const id = ++loadRef.current;
    try {
      const response = await fetch(`${base}/dashboard`, { cache: 'no-store' });
      const body = (await response.json()) as {
        entries?: ConsoleEntry[];
        session?: DashboardSession;
        message?: string;
      };
      if (!response.ok || !body.entries || !body.session)
        throw new Error(body.message);
      if (id !== loadRef.current) return '';
      setEntries(body.entries);
      setSession(body.session);
      setState('ready');
      return '';
    } catch (error) {
      if (id !== loadRef.current) return '';
      const text =
        error instanceof Error && error.message ? error.message : t.queueError;
      setState((s) => (s === 'ready' ? 'ready' : 'error'));
      return text;
    }
  }, [base, t.queueError]);

  useEffect(() => {
    const first = window.setTimeout(() => void load().then(setMessage), 0);
    const poll = window.setInterval(
      () => void load().then((m) => m && setMessage(m)),
      30_000,
    );
    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
    };
  }, [load]);

  /** One existing command per press; the screen shows only the committed result. */
  async function post(path: string, operation: string, payload: object) {
    let idempotencyKey = keysRef.current.get(operation);
    if (!idempotencyKey) {
      idempotencyKey = key();
      keysRef.current.set(operation, idempotencyKey);
    }
    setBusy(true);
    setMessage('');
    let failure = '';
    try {
      const response = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as {
        entry?: unknown;
        session?: unknown;
        message?: string;
      };
      if (!response.ok || !(body.entry || body.session))
        throw new Error(body.message);
      keysRef.current.delete(operation);
    } catch (error) {
      failure =
        error instanceof Error && error.message ? error.message : t.queueError;
    }
    const loadFailure = await load();
    setMessage(failure || loadFailure);
    setBusy(false);
    return failure === '';
  }

  const view = session ? buildDoctorView(entries, session.status) : null;
  const live = session?.status === 'open' || session?.status === 'paused';
  const delay = session?.declaredDelayMinutes ?? 0;

  function entryCommand(
    entry: ConsoleEntry,
    command: string,
    entryReason?: string,
  ) {
    return post(
      `queue/${entry.id}/commands`,
      `${entry.id}:${command}:${entryReason ?? ''}`,
      { command, reason: entryReason },
    );
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
    void post(
      'delay',
      `session:delay:${session.delayVersion}:${minutes}`,
      payload,
    );
  }

  const primaryLabel = (() => {
    if (!view?.primary) return t.noneToCall;
    const who = `${view.primary.entry.publicDisplayLabel} · ${view.primary.entry.privateDisplayName}`;
    if (view.primary.command === 'complete_consultation')
      return t.completeConsultation;
    if (view.primary.command === 'start_consultation')
      return `${t.startConsultation} · ${who}`;
    return `${t.callNext} · ${who}`;
  })();

  return (
    <main className="doctorView" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <DocumentLocaleSync locale={locale} />
      <header className="doctorHeader">
        <div>
          <h1>{session?.doctorDisplayName ?? d.title}</h1>
          {session && <small>{t.statuses[session.status]}</small>}
        </div>
        <button
          type="button"
          className="locale"
          onClick={() => setLocale(locale === 'ar' ? 'fr' : 'ar')}
        >
          {locale === 'ar' ? 'Français' : 'العربية'}
        </button>
      </header>

      {state === 'loading' && <p role="status">{t.loading}</p>}
      {state === 'error' && (
        <p role="alert">
          {message || t.queueError}{' '}
          <button type="button" onClick={() => void load().then(setMessage)}>
            {t.reload}
          </button>
        </p>
      )}
      {state === 'ready' && session && view && (
        <>
          <div className="doctorControls">
            {(session.status === 'open' || session.status === 'paused') && (
              <button
                type="button"
                className="quiet"
                aria-pressed={session.status === 'paused'}
                disabled={busy}
                onClick={() =>
                  void post('commands', 'session:toggle', {
                    command: session.status === 'open' ? 'pause' : 'resume',
                  })
                }
              >
                {session.status === 'open' ? t.pause : t.resume}
              </button>
            )}
            <div className="delayStepper" role="group" aria-label={t.delay}>
              <button
                type="button"
                aria-label={`${t.delay} −`}
                disabled={busy || !live || delay <= 0}
                onClick={() => setDelay(steppedDelay(delay, -1))}
              >
                −
              </button>
              <span aria-live="polite" className="delayValue">
                {delay > 0 ? `${delay} ${t.minutes}` : t.noDelay}
              </span>
              <button
                type="button"
                aria-label={`${t.delay} +`}
                disabled={busy || !live || delay >= CONSOLE_DELAY_MAX_MINUTES}
                onClick={() => setDelay(steppedDelay(delay, 1))}
              >
                +
              </button>
            </div>
          </div>
          {view.paused && (
            <div className="pausedBanner" role="status">
              {t.pausedBanner}
            </div>
          )}
          {message && (
            <p className="doctorError" role="alert">
              {message}
            </p>
          )}

          <section className="doctorCurrent" aria-label={d.inConsultTitle}>
            {view.current ? (
              <>
                <small>
                  {view.current.state === 'in_consultation'
                    ? d.inConsultTitle
                    : d.calledTitle}
                </small>
                <strong className="ticket">
                  {view.current.publicDisplayLabel}
                </strong>
                <span>{view.current.privateDisplayName}</span>
                {view.current.state === 'in_consultation' &&
                  view.current.activeConsultationRemainingMinutes !== null && (
                    <small>
                      {t.remainingConsult.replace(
                        '{n}',
                        String(view.current.activeConsultationRemainingMinutes),
                      )}
                    </small>
                  )}
              </>
            ) : (
              <span>{d.noCurrent}</span>
            )}
          </section>

          <button
            type="button"
            className="doctorPrimary"
            disabled={busy || !view.primary || view.primary.disabled}
            onClick={() => {
              if (view.primary)
                void entryCommand(view.primary.entry, view.primary.command);
            }}
          >
            {primaryLabel}
          </button>

          {view.canNoShow && view.current && (
            <div className="doctorNoShow">
              {!noShowOpen ? (
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => setNoShowOpen(true)}
                >
                  {d.noShowAsk}
                </button>
              ) : (
                <>
                  <label>
                    {t.queueReason}
                    <input
                      value={reason}
                      maxLength={200}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy || reason.trim() === ''}
                    onClick={() => {
                      const target = view.current;
                      if (!target) return;
                      void entryCommand(target, 'no_show', reason.trim()).then(
                        (ok) => {
                          if (!ok) return;
                          setNoShowOpen(false);
                          setReason('');
                        },
                      );
                    }}
                  >
                    {d.noShowConfirm}
                  </button>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => {
                      setNoShowOpen(false);
                      setReason('');
                    }}
                  >
                    {d.cancelPanel}
                  </button>
                </>
              )}
            </div>
          )}

          <section className="doctorNext" aria-label={d.nextTitle}>
            <h2>{d.nextTitle}</h2>
            {view.next.length === 0 ? (
              <p>{d.nextEmpty}</p>
            ) : (
              <ol>
                {view.next.slice(0, DOCTOR_NEXT_LIST_LIMIT).map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.publicDisplayLabel}</strong>{' '}
                    <span>{entry.privateDisplayName}</span>
                    <small>{formatWaitRange(entry.eta, t)}</small>
                  </li>
                ))}
              </ol>
            )}
            <small>
              {d.notArrived.replace('{n}', String(view.notArrivedCount))}
            </small>
          </section>
          <footer className="doctorToday">
            {d.today
              .replace('{done}', String(view.completedCount))
              .replace('{absent}', String(view.noShowCount))}
          </footer>
        </>
      )}
    </main>
  );
}
