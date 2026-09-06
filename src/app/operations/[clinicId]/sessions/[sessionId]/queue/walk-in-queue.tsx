'use client';

import Link from 'next/link';
import { receptionistCopy } from '@/modules/localization/receptionist';
import { useCallback, useEffect, useRef, useState } from 'react';

type WaitingEntry = {
  id: string;
  sessionId: string;
  state: 'waiting';
  registrationOrder: number;
  publicDisplayLabel: string;
  privateDisplayName: string;
  preferredLocale: 'ar' | 'fr';
  hasContact: boolean;
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
  const pendingKeysRef = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/queue`,
        { cache: 'no-store' },
      );
      const body = (await response.json()) as {
        entries?: WaitingEntry[];
        message?: string;
      };
      if (!response.ok || !body.entries) throw new Error(body.message);
      setEntries(body.entries);
      setState('ready');
    } catch (error) {
      setState('error');
      setMessage(
        error instanceof Error && error.message ? error.message : t.error,
      );
    }
  }, [clinicId, sessionId, t.error]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      privateDisplayName: String(data.get('privateDisplayName') ?? '').trim(),
      contactPhone: String(data.get('contactPhone') ?? '').trim() || null,
      contactEmail: String(data.get('contactEmail') ?? '').trim() || null,
      preferredLocale: locale,
    };
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
        registration?: { entry: WaitingEntry };
        message?: string;
      };
      if (!response.ok || !body.registration) throw new Error(body.message);
      form.reset();
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error && error.message ? error.message : t.queueError,
      );
    } finally {
      setPending(false);
    }
  }

  function reload() {
    setState('loading');
    setMessage('');
    void load();
  }

  return (
    <main className="desk" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
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

      {message && (
        <div className="alert" role="alert">
          {message}
        </div>
      )}

      <section className="createPanel">
        <h2>{t.addWalkIn}</h2>
        <p>{t.contactOptionalHint}</p>
        <form className="walkInForm" onSubmit={(event) => void register(event)}>
          <label>
            {t.guestName}
            <input required maxLength={120} name="privateDisplayName" />
          </label>
          <label>
            {t.phoneOptional}
            <input maxLength={32} name="contactPhone" inputMode="tel" />
          </label>
          <label>
            {t.emailOptional}
            <input maxLength={254} name="contactEmail" type="email" />
          </label>
          <button disabled={pending}>
            {pending ? t.pending : t.addWalkIn}
          </button>
        </form>
      </section>

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
      {state === 'ready' && entries.length > 0 && (
        <section className="queueList" aria-label={t.queueTitle}>
          {entries.map((entry) => (
            <article className="queueRow" key={entry.id}>
              <div>
                <strong>{entry.privateDisplayName}</strong>
                <small>
                  {entry.hasContact ? t.contactOnFile : t.noContact}
                </small>
              </div>
              <div className="queueIdentity">
                <span>{t.publicLabel}</span>
                <strong>{entry.publicDisplayLabel}</strong>
              </div>
              <span className="registrationOrder">
                #{entry.registrationOrder}
              </span>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
