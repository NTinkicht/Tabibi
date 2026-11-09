'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Button, Chip } from '@/app/ui';
import { clinicSetupCopy } from '@/modules/localization/clinic-setup';
import {
  buildNewTypeBody,
  formatClosureDay,
  parseClosures,
  parseConsultationTypes,
  suggestCode,
  type ConsultationTypeRow,
} from '../consultation-type-model';

type Locale = 'ar' | 'fr';
type Props = { base: string; locale: Locale; onForbidden: () => void };

const JSON_HEADERS = { 'content-type': 'application/json' };

function useFocusedMessage(message: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  return ref;
}

export function ClosuresSection({ base, locale, onForbidden }: Props) {
  const t = clinicSetupCopy[locale];
  const [days, setDays] = useState<string[] | null>(null);
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useFocusedMessage(error);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${base}/closures`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (res.status === 403) return onForbidden();
        const parsed = res.ok ? parseClosures(await res.json()) : null;
        if (parsed) setDays(parsed);
        else setError(t.sectionLoadError);
      } catch {
        if (!controller.signal.aborted) setError(t.sectionLoadError);
      }
    })();
    return () => controller.abort();
  }, [base, tick, onForbidden, t.sectionLoadError]);

  async function mutate(
    request: () => Promise<Response>,
    success: string,
    conflict?: string,
  ): Promise<boolean> {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const res = await request();
      if (res.status === 403) {
        onForbidden();
        return false;
      }
      if (!res.ok) {
        setError(res.status === 409 && conflict ? conflict : t.actionFailed);
        return false;
      }
      // Honest state: re-read the committed list instead of patching locally.
      reload();
      setOk(success);
      return true;
    } catch {
      setError(t.actionFailed);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function onAdd(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError(t.closureNeedsDate);
    void mutate(
      () =>
        fetch(`${base}/closures`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify({ closureDate: date }),
        }),
      t.closureAdded,
      t.closureConflict,
    ).then((saved) => {
      if (saved) setDate('');
    });
  }

  return (
    <section className="cs-card" aria-labelledby="cs-closures-title">
      <h2 id="cs-closures-title">{t.closuresTitle}</h2>
      <p className="cs-help">{t.closuresHelp}</p>
      {error && (
        <div className="cs-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </div>
      )}
      {days && days.length === 0 && <p>{t.closuresEmpty}</p>}
      {days && days.length > 0 && (
        <ul className="cs-list">
          {days.map((day) => (
            <li key={day} className="cs-row">
              <bdi>{formatClosureDay(day, locale)}</bdi>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    () =>
                      fetch(`${base}/closures/${day}`, {
                        method: 'DELETE',
                        credentials: 'same-origin',
                      }),
                    t.closureRemoved,
                  )
                }
              >
                {t.closureRemove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="cs-inline" onSubmit={onAdd} noValidate>
        <div className="cs-field">
          <label htmlFor="cs-closure-date">{t.closureDate}</label>
          <input
            id="cs-closure-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy}>
          {t.closureAdd}
        </Button>
      </form>
      {ok && (
        <p className="cs-ok" role="status">
          {ok}
        </p>
      )}
    </section>
  );
}

export function ConsultationTypesSection({ base, locale, onForbidden }: Props) {
  const t = clinicSetupCopy[locale];
  const [rows, setRows] = useState<ConsultationTypeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const [duration, setDuration] = useState('15');
  const errorRef = useFocusedMessage(error);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `${base}/consultation-types?includeInactive=true`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (res.status === 403) return onForbidden();
        const parsed = res.ok ? parseConsultationTypes(await res.json()) : null;
        if (parsed) setRows(parsed);
        else setError(t.sectionLoadError);
      } catch {
        if (!controller.signal.aborted) setError(t.sectionLoadError);
      }
    })();
    return () => controller.abort();
  }, [base, tick, onForbidden, t.sectionLoadError]);

  async function send(
    request: () => Promise<Response>,
    success: string,
  ): Promise<boolean> {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const res = await request();
      if (res.status === 403) {
        onForbidden();
        return false;
      }
      if (!res.ok) {
        setError(res.status === 409 ? t.typeErrors.conflict : t.actionFailed);
        return false;
      }
      reload();
      setOk(success);
      return true;
    } catch {
      setError(t.actionFailed);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function setActive(row: ConsultationTypeRow, active: boolean) {
    void send(
      () =>
        fetch(`${base}/consultation-types/${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify({ active }),
        }),
      t.typeUpdated,
    );
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    const built = buildNewTypeBody({ label, code, duration });
    if (!built.ok) {
      setOk(null);
      return setError(t.typeErrors[built.error]);
    }
    const saved = await send(
      () =>
        fetch(`${base}/consultation-types`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify(built.body),
        }),
      t.typeAdded,
    );
    if (saved) {
      setAdding(false);
      setLabel('');
      setCode('');
      setCodeEdited(false);
      setDuration('15');
    }
  }

  return (
    <section className="cs-card" aria-labelledby="cs-types-title">
      <h2 id="cs-types-title">{t.typesTitle}</h2>
      <p className="cs-help">{t.typesHelp}</p>
      {error && (
        <div className="cs-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </div>
      )}
      {rows && rows.length === 0 && <p>{t.typesEmpty}</p>}
      {rows && rows.length > 0 && (
        <table className="cs-table">
          <thead>
            <tr>
              <th scope="col">{t.typeLabel}</th>
              <th scope="col">{t.typeDuration}</th>
              <th scope="col">{t.typeState}</th>
              <th scope="col">
                <span className="cs-sr">{t.typesTitle}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <bdi>{row.label}</bdi>
                </td>
                <td>
                  <bdi>{row.nominalDurationMinutes}</bdi>
                </td>
                <td>
                  <Chip tone={row.active ? 'active' : 'neutral'}>
                    {row.active ? t.typeActive : t.typeInactive}
                  </Chip>
                </td>
                <td>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setActive(row, !row.active)}
                  >
                    {row.active ? t.typeDeactivate : t.typeReactivate}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!adding && (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          {t.typeAdd}
        </Button>
      )}
      {adding && (
        <form className="cs-inline" onSubmit={onAdd} noValidate>
          <fieldset className="cs-lock cs-inline" disabled={busy}>
            <div className="cs-field">
              <label htmlFor="cs-type-label">{t.typeLabel}</label>
              <input
                id="cs-type-label"
                type="text"
                value={label}
                maxLength={80}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (!codeEdited) setCode(suggestCode(e.target.value));
                }}
              />
            </div>
            <div className="cs-field">
              <label htmlFor="cs-type-code">{t.typeCode}</label>
              <input
                id="cs-type-code"
                type="text"
                dir="ltr"
                value={code}
                maxLength={48}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeEdited(true);
                }}
              />
            </div>
            <div className="cs-field">
              <label htmlFor="cs-type-duration">{t.typeDuration}</label>
              <input
                id="cs-type-duration"
                type="number"
                inputMode="numeric"
                min={5}
                max={240}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
            <Button type="submit">{t.typeSave}</Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAdding(false)}
            >
              {t.typeCancel}
            </Button>
          </fieldset>
        </form>
      )}
      {ok && (
        <p className="cs-ok" role="status">
          {ok}
        </p>
      )}
    </section>
  );
}
