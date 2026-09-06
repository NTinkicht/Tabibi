'use client';
import { receptionistCopy } from '@/modules/localization/receptionist';
import { useCallback, useEffect, useState } from 'react';

type Status = 'planned' | 'open' | 'paused' | 'closed' | 'cancelled';
type Session = {
  id: string;
  doctorId: string;
  doctorDisplayName: string;
  startsAt: string;
  endsAt: string;
  status: Status;
  openedAt: string | null;
  closedAt: string | null;
  declaredDelayMinutes: number | null;
  delayVersion: number;
};

function key() {
  return crypto.randomUUID();
}
export function ReceptionDesk({ clinicId }: { clinicId: string }) {
  const [locale, setLocale] = useState<'ar' | 'fr'>('ar');
  const t = receptionistCopy[locale];
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setState('loading');
    setMessage('');
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions?date=${date}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error();
      const body = (await response.json()) as { sessions: Session[] };
      setSessions(body.sessions);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [clinicId, date]);
  useEffect(() => {
    void load();
  }, [load]);
  async function mutate(sessionId: string, path: string, body: object) {
    setPending(sessionId);
    setMessage('');
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': key(),
          },
          body: JSON.stringify(body),
        },
      );
      const data = (await response.json()) as {
        session?: Session;
        message?: string;
      };
      if (!response.ok || !data.session) throw new Error(data.message);
      setSessions((items) =>
        items.map((item) => (item.id === sessionId ? data.session! : item)),
      );
    } catch (error) {
      setMessage(
        error instanceof Error && error.message ? error.message : t.error,
      );
    } finally {
      setPending(null);
    }
  }
  async function command(session: Session, command: string) {
    let reason: string | undefined;
    if (command === 'cancel') {
      reason = window.prompt(t.promptCancel)?.trim();
      if (!reason) return;
    }
    await mutate(session.id, 'commands', { command, reason });
  }
  async function delay(session: Session) {
    const raw = window.prompt(t.promptDelay);
    if (raw === null) return;
    const minutes = Number(raw);
    await mutate(session.id, 'delay', {
      command:
        session.declaredDelayMinutes === null
          ? 'declare_delay'
          : 'update_delay',
      minutes,
      expectedVersion: session.delayVersion,
    });
  }
  async function clearDelay(session: Session) {
    await mutate(session.id, 'delay', {
      command: 'clear_delay',
      expectedVersion: session.delayVersion,
    });
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending('create');
    try {
      const start = String(data.get('start'));
      const end = String(data.get('end'));
      const response = await fetch(`/api/clinics/${clinicId}/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({
          doctorId: data.get('doctorId'),
          serviceDate: date,
          startsAt: new Date(`${date}T${start}`).toISOString(),
          endsAt: new Date(`${date}T${end}`).toISOString(),
        }),
      });
      const body = (await response.json()) as {
        session?: Session;
        message?: string;
      };
      if (!response.ok) throw new Error(body.message);
      await load();
      event.currentTarget.reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.error);
    } finally {
      setPending(null);
    }
  }
  return (
    <main className="desk" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="deskHeader">
        <div>
          <span className="eyebrow">TABIBI · RECEPTION</span>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        <button
          className="locale"
          onClick={() => setLocale(locale === 'ar' ? 'fr' : 'ar')}
        >
          {locale === 'ar' ? 'Français' : 'العربية'}
        </button>
      </header>
      <section className="toolbar">
        <label>
          <span className="srOnly">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button onClick={() => void load()}>{t.reload}</button>
      </section>
      {message && (
        <div className="alert" role="alert">
          {message}
        </div>
      )}
      {state === 'loading' && (
        <div className="state" aria-live="polite">
          <span className="spinner" />
          {t.loading}
        </div>
      )}
      {state === 'error' && (
        <div className="state error">
          <p>{t.error}</p>
          <button onClick={() => void load()}>{t.reload}</button>
        </div>
      )}
      {state === 'ready' && sessions.length === 0 && (
        <div className="state">
          <span className="emptyIcon">◷</span>
          <p>{t.empty}</p>
        </div>
      )}
      <section className="sessionGrid" aria-busy={pending !== null}>
        {sessions.map((session) => (
          <article
            className={`sessionCard status-${session.status}`}
            key={session.id}
          >
            <div className="sessionTop">
              <div>
                <h2>{session.doctorDisplayName}</h2>
                <p className="time">
                  {new Intl.DateTimeFormat(
                    locale === 'ar' ? 'ar-DZ' : 'fr-DZ',
                    { hour: '2-digit', minute: '2-digit' },
                  ).format(new Date(session.startsAt))}{' '}
                  —{' '}
                  {new Intl.DateTimeFormat(
                    locale === 'ar' ? 'ar-DZ' : 'fr-DZ',
                    { hour: '2-digit', minute: '2-digit' },
                  ).format(new Date(session.endsAt))}
                </p>
              </div>
              <span className="status">{t.statuses[session.status]}</span>
            </div>
            {session.declaredDelayMinutes !== null && (
              <p className="delayBadge">
                +{session.declaredDelayMinutes} {t.minutes}
              </p>
            )}
            <div className="actions">
              {session.status === 'planned' && (
                <button onClick={() => void command(session, 'open')}>
                  {t.open}
                </button>
              )}
              {session.status === 'open' && (
                <button onClick={() => void command(session, 'pause')}>
                  {t.pause}
                </button>
              )}
              {session.status === 'paused' && (
                <button onClick={() => void command(session, 'resume')}>
                  {t.resume}
                </button>
              )}
              {['open', 'paused'].includes(session.status) && (
                <button onClick={() => void command(session, 'close')}>
                  {t.close}
                </button>
              )}
              {!['closed', 'cancelled'].includes(session.status) && (
                <button
                  className="danger"
                  onClick={() => void command(session, 'cancel')}
                >
                  {t.cancel}
                </button>
              )}
              {!['closed', 'cancelled'].includes(session.status) && (
                <button className="quiet" onClick={() => void delay(session)}>
                  {t.delay}
                </button>
              )}
              {session.declaredDelayMinutes !== null && (
                <button
                  className="quiet"
                  onClick={() => void clearDelay(session)}
                >
                  {t.clear}
                </button>
              )}
            </div>
            {pending === session.id && (
              <div className="pending" aria-live="polite">
                {t.pending}
              </div>
            )}
          </article>
        ))}
      </section>
      <section className="createPanel">
        <h2>{t.add}</h2>
        <form onSubmit={(e) => void create(e)}>
          <label>
            {t.doctor}
            <input required name="doctorId" placeholder="UUID" />
          </label>
          <label>
            {t.start}
            <input required name="start" type="time" />
          </label>
          <label>
            {t.end}
            <input required name="end" type="time" />
          </label>
          <button disabled={pending === 'create'}>
            {pending === 'create' ? t.pending : t.save}
          </button>
        </form>
      </section>
    </main>
  );
}
