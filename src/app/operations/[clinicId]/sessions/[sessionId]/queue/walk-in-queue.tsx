'use client';

import Link from 'next/link';
import { receptionistCopy } from '@/modules/localization/receptionist';
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
  serviceOrder?: number | null;
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
  const [queueOrderVersion, setQueueOrderVersion] = useState(0);
  const pendingKeysRef = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/queue`,
        { cache: 'no-store' },
      );
      const body = (await response.json()) as {
        entries?: WaitingEntry[];
        queueOrderVersion?: number;
        message?: string;
      };
      if (!response.ok || !body.entries) throw new Error(body.message);
      setEntries(body.entries);
      setQueueOrderVersion(body.queueOrderVersion ?? 0);
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
      preferredLocale: String(data.get('preferredLocale') ?? 'ar') as
        | 'ar'
        | 'fr',
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

  async function command(
    entry: WaitingEntry,
    commandName:
      | 'check_in'
      | 'call'
      | 'no_show'
      | 'cancel'
      | 'start_consultation'
      | 'complete_consultation',
  ) {
    let reason: string | undefined;
    let cancellationSource: 'patient' | 'clinic' | undefined;
    if (commandName === 'no_show' || commandName === 'cancel') {
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
      setEntries((items) =>
        items.map((item) => (item.id === entry.id ? body.entry! : item)),
      );
    } catch (error) {
      setMessage(
        error instanceof Error && error.message ? error.message : t.queueError,
      );
    } finally {
      setPendingEntry(null);
    }
  }

  async function reorder(entry: WaitingEntry) {
    const rawPosition = window.prompt(t.reorderPosition);
    if (rawPosition === null) return;
    const targetPosition = Number(rawPosition);
    if (!Number.isInteger(targetPosition) || targetPosition < 1) {
      setMessage(t.reorderInvalid);
      return;
    }
    const reason = window.prompt(t.reorderReason)?.trim();
    if (!reason) return;
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
      setQueueOrderVersion(body.queueOrderVersion);
      setEntries((items) => {
        const rank = new Map(
          body.orderedEntryIds!.map((id, index) => [id, index + 1]),
        );
        return [...items]
          .map((item) => ({
            ...item,
            serviceOrder: rank.get(item.id) ?? item.serviceOrder,
          }))
          .sort((left, right) => {
            if (left.state === 'checked_in' && right.state === 'checked_in')
              return (
                (left.serviceOrder ?? Number.MAX_SAFE_INTEGER) -
                (right.serviceOrder ?? Number.MAX_SAFE_INTEGER)
              );
            return left.registrationOrder - right.registrationOrder;
          });
      });
    } catch (error) {
      setMessage(
        error instanceof Error && error.message ? error.message : t.queueError,
      );
      await load();
    } finally {
      setPendingEntry(null);
    }
  }

  const actionFor: Record<
    EntryState,
    {
      command: Parameters<typeof command>[1];
      label: string;
      danger?: boolean;
    } | null
  > = {
    waiting: { command: 'check_in', label: t.checkIn },
    checked_in: { command: 'call', label: t.call },
    called: { command: 'start_consultation', label: t.startConsultation },
    in_consultation: {
      command: 'complete_consultation',
      label: t.completeConsultation,
    },
    completed: null,
    cancelled: null,
    no_show: null,
  };

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
          <label>
            {t.patientLanguage}
            <select defaultValue="ar" name="preferredLocale">
              <option value="ar">{t.patientLanguageArabic}</option>
              <option value="fr">{t.patientLanguageFrench}</option>
            </select>
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
                {entry.state === 'checked_in' && entry.serviceOrder
                  ? `${t.serviceOrder} #${entry.serviceOrder}`
                  : `${t.registrationOrder} #${entry.registrationOrder}`}
              </span>
              <span className={`queueState queueState-${entry.state}`}>
                {t.queueStatuses[entry.state]}
              </span>
              <div className="queueActions">
                {actionFor[entry.state] && (
                  <button
                    disabled={pendingEntry !== null}
                    onClick={() =>
                      void command(entry, actionFor[entry.state]!.command)
                    }
                  >
                    {pendingEntry === entry.id
                      ? t.pending
                      : actionFor[entry.state]!.label}
                  </button>
                )}
                {['checked_in', 'called'].includes(entry.state) && (
                  <button
                    className="quiet"
                    disabled={pendingEntry !== null}
                    onClick={() => void command(entry, 'no_show')}
                  >
                    {t.noShow}
                  </button>
                )}
                {['waiting', 'checked_in', 'called'].includes(entry.state) && (
                  <button
                    className="danger"
                    disabled={pendingEntry !== null}
                    onClick={() => void command(entry, 'cancel')}
                  >
                    {t.cancelEntry}
                  </button>
                )}
                {entry.state === 'checked_in' && (
                  <button
                    className="priorityAction"
                    disabled={pendingEntry !== null}
                    onClick={() => void reorder(entry)}
                  >
                    {t.reorderAudited}
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
