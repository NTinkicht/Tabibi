'use client';
import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import Link from 'next/link';
import './reception-home.css';
import { Button } from '@/app/ui';
import { shiftDate } from '@/modules/receptionist-dashboard/home-view';
import { SessionCard, type HomeSession } from './session-card';
import { receptionistCopy } from '@/modules/localization/receptionist';
import { useCallback, useEffect, useRef, useState } from 'react';

type Session = HomeSession;

function key() {
  return crypto.randomUUID();
}
function localDateString(instant: Date): string {
  const offsetMs = instant.getTimezoneOffset() * 60_000;
  return new Date(instant.getTime() - offsetMs).toISOString().slice(0, 10);
}
export function ReceptionDesk({
  clinicId,
  initialLocale = 'ar',
}: {
  clinicId: string;
  initialLocale?: 'ar' | 'fr';
}) {
  const [locale, setLocale] = useState<'ar' | 'fr'>(initialLocale);
  const t = receptionistCopy[locale];
  const [date, setDate] = useState(() => localDateString(new Date()));
  const [timezone, setTimezone] = useState('UTC');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [undelivered, setUndelivered] = useState(0);
  const [undeliveredUnknown, setUndeliveredUnknown] = useState(false);
  const [delayMinutes, setDelayMinutes] = useState<Record<string, string>>({});
  const pendingKeysRef = useRef(new Map<string, string>());

  function keyFor(opId: string): string {
    const existing = pendingKeysRef.current.get(opId);
    if (existing) return existing;
    const generated = key();
    pendingKeysRef.current.set(opId, generated);
    return generated;
  }
  function releaseKey(opId: string): void {
    pendingKeysRef.current.delete(opId);
  }
  const load = useCallback(async () => {
    setState('loading');
    setMessage('');
    setSessions([]);
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions?date=${date}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error();
      const body = (await response.json()) as {
        sessions: Session[];
        timezone: string;
      };
      setSessions(body.sessions);
      setTimezone(body.timezone);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [clinicId, date]);
  useEffect(() => {
    // Fetch-on-change: load() resets the list and shows the loading state first.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    // Banner is best effort: a failure here must never block the day's sessions.
    // Both failure sources shown on the notifications page count; if either
    // fetch fails the link is still offered (fail-safe, never hide failures).
    const controller = new AbortController();
    const init = { cache: 'no-store' as const, signal: controller.signal };
    const base = `/api/clinics/${clinicId}/notifications`;
    const count = async (
      url: string,
      field: string,
    ): Promise<number | null> => {
      try {
        const response = await fetch(url, init);
        if (!response.ok) return null;
        const body = (await response.json()) as Record<string, unknown> | null;
        const list = body?.[field];
        return Array.isArray(list) ? list.length : null;
      } catch {
        return null;
      }
    };
    void Promise.all([
      count(`${base}/dead-letters?limit=100`, 'deadLetters'),
      count(`${base}/guest-link-failures?limit=100`, 'failures'),
    ]).then(([dead, guest]) => {
      if (controller.signal.aborted) return;
      setUndelivered(
        dead !== null && guest !== null
          ? dead + guest
          : (dead ?? 0) + (guest ?? 0),
      );
      setUndeliveredUnknown(dead === null || guest === null);
    });
    return () => controller.abort();
  }, [clinicId]);
  async function mutate(
    sessionId: string,
    opId: string,
    path: string,
    body: object,
  ) {
    setPending(sessionId);
    setMessage('');
    const idempotencyKey = keyFor(opId);
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify(body),
        },
      );
      releaseKey(opId);
      const data = (await response.json()) as {
        session?: Session;
        message?: string;
      };
      if (!response.ok || !data.session) throw new Error(data.message);
      // Mutation responses carry no queueCounts: keep the last known counts.
      setSessions((items) =>
        items.map((item) =>
          item.id === sessionId
            ? {
                ...data.session!,
                queueCounts: data.session!.queueCounts ?? item.queueCounts,
              }
            : item,
        ),
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
    await mutate(session.id, `${session.id}:command:${command}`, 'commands', {
      command,
      reason,
    });
  }
  async function delay(
    event: React.FormEvent<HTMLFormElement>,
    session: Session,
  ) {
    event.preventDefault();
    const raw = delayMinutes[session.id] ?? '';
    const minutes = Number(raw);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) {
      setMessage(t.delayInvalid);
      return;
    }
    const delayCommand =
      session.declaredDelayMinutes === null ? 'declare_delay' : 'update_delay';
    await mutate(session.id, `${session.id}:delay:${delayCommand}`, 'delay', {
      command: delayCommand,
      minutes,
      expectedVersion: session.delayVersion,
    });
  }
  async function clearDelay(session: Session) {
    await mutate(session.id, `${session.id}:delay:clear_delay`, 'delay', {
      command: 'clear_delay',
      expectedVersion: session.delayVersion,
    });
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending('create');
    const idempotencyKey = keyFor('create');
    try {
      const start = String(data.get('start'));
      const end = String(data.get('end'));
      const response = await fetch(`/api/clinics/${clinicId}/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          doctorId: data.get('doctorId'),
          serviceDate: date,
          startsAt: new Date(`${date}T${start}`).toISOString(),
          endsAt: new Date(`${date}T${end}`).toISOString(),
        }),
      });
      releaseKey('create');
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
    <main className="rh" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <DocumentLocaleSync locale={locale} />
      <header className="rh-header">
        <h1>{t.title}</h1>
        <button
          type="button"
          className="tb-button tb-button--secondary"
          onClick={() => setLocale(locale === 'ar' ? 'fr' : 'ar')}
        >
          {locale === 'ar' ? 'Français' : 'العربية'}
        </button>
      </header>
      <div className="rh-date">
        <Button
          variant="secondary"
          aria-label={t.homePrevDay}
          onClick={() => setDate((value) => shiftDate(value, -1))}
        >
          <span aria-hidden="true">{locale === 'ar' ? '›' : '‹'}</span>
        </Button>
        <label>
          <span className="srOnly">{t.homeDate}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </label>
        <Button
          variant="secondary"
          aria-label={t.homeNextDay}
          onClick={() => setDate((value) => shiftDate(value, 1))}
        >
          <span aria-hidden="true">{locale === 'ar' ? '‹' : '›'}</span>
        </Button>
        <Button
          variant="secondary"
          onClick={() => setDate(localDateString(new Date()))}
        >
          {t.homeToday}
        </Button>
        <Button variant="secondary" onClick={() => void load()}>
          {t.reload}
        </Button>
      </div>
      {(undelivered > 0 || undeliveredUnknown) && (
        <div className="rh-banner" role="status">
          {undelivered > 0 && (
            <span>{t.homeUndelivered.replace('{n}', String(undelivered))}</span>
          )}
          <Link href={`/operations/${clinicId}/notifications?locale=${locale}`}>
            {t.notifications}
          </Link>
        </div>
      )}
      {message && (
        <div className="rh-alert" role="alert">
          {message}
        </div>
      )}
      {state === 'loading' && (
        <div className="rh-state" aria-live="polite">
          {t.loading}
        </div>
      )}
      {state === 'error' && (
        <div className="rh-state rh-state--error">
          <p>{t.error}</p>
          <Button variant="secondary" onClick={() => void load()}>
            {t.reload}
          </Button>
        </div>
      )}
      {state === 'ready' && sessions.length === 0 && (
        <div className="rh-state">
          <p>{t.homeEmptyDay}</p>
        </div>
      )}
      <section
        className="rh-grid"
        aria-busy={pending !== null || state === 'loading'}
      >
        {sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            clinicId={clinicId}
            t={t}
            locale={locale}
            timezone={timezone}
            pending={pending === session.id}
            delayValue={
              delayMinutes[session.id] ??
              String(session.declaredDelayMinutes ?? '')
            }
            onCommand={(item, name) => void command(item, name)}
            onDelayChange={(id, value) =>
              setDelayMinutes((values) => ({ ...values, [id]: value }))
            }
            onDelaySubmit={(event, item) => void delay(event, item)}
            onClearDelay={(item) => void clearDelay(item)}
          />
        ))}
      </section>
      <section className="rh-create">
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
          <Button type="submit" disabled={pending === 'create'}>
            {pending === 'create' ? t.pending : t.save}
          </Button>
        </form>
      </section>
    </main>
  );
}
