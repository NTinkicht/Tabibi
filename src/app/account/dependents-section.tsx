'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/app/ui';
import { accountStrings, type AccountLocale } from './strings';

interface Dependent {
  id: string;
  displayName: string;
}
type Failure = 'dependentInvalid' | 'rateLimited' | 'unavailable';

function classify(status: number): Failure {
  if (status === 429) return 'rateLimited';
  if (status === 400) return 'dependentInvalid';
  return 'unavailable';
}

function parseList(body: unknown): Dependent[] | null {
  const list = (body as { dependents?: unknown })?.dependents;
  if (!Array.isArray(list)) return null;
  const parsed: Dependent[] = [];
  for (const item of list) {
    const { id, displayName } = (item ?? {}) as Partial<Dependent>;
    if (typeof id !== 'string' || typeof displayName !== 'string') return null;
    parsed.push({ id, displayName });
  }
  return parsed;
}

// TAB-P1-03: nonclinical dependent profiles over the owner-scoped
// /api/patient/dependents routes. A dependent is only a display name. The
// owner is always the signed-in session, and a 401 returns the page to the
// signed-out state instead of showing a stale list.
export function DependentsSection({
  locale,
  onSignedOut,
}: {
  locale: AccountLocale;
  onSignedOut: () => void;
}) {
  const t = accountStrings[locale];
  const [items, setItems] = useState<Dependent[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  // Every mutation bumps `attempt`, which re-reads the owner-scoped list.
  useEffect(() => {
    let live = true;
    fetch('/api/patient/dependents')
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) return onSignedOut();
        const parsed = response.ok ? parseList(await response.json()) : null;
        if (!parsed) throw new Error('dependents-load-failed');
        if (!live) return;
        setItems(parsed);
        setLoadFailed(false);
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [attempt, onSignedOut]);

  useEffect(() => {
    if (failure) summaryRef.current?.focus();
  }, [failure]);

  async function send(
    url: string,
    method: string,
    body: unknown,
  ): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) {
        onSignedOut();
        return false;
      }
      if (!response.ok) {
        setFailure(classify(response.status));
        return false;
      }
      setAttempt((n) => n + 1);
      return true;
    } catch {
      setFailure('unavailable');
      return false;
    } finally {
      setPending(false);
    }
  }

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('displayName') ?? '');
    if (await send('/api/patient/dependents', 'POST', { displayName: name }))
      form.reset();
  }

  async function rename(event: React.FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('displayName'));
    if (
      await send(`/api/patient/dependents/${encodeURIComponent(id)}`, 'PATCH', {
        displayName: name,
      })
    )
      setEditing(null);
  }

  return (
    <section
      aria-labelledby="account-dependents-title"
      data-testid="dependents"
    >
      <h2 id="account-dependents-title">{t.dependentsTitle}</h2>
      <p className="si-subtitle">{t.dependentsHint}</p>
      {failure ? (
        <div
          ref={summaryRef}
          className="si-error"
          tabIndex={-1}
          role="alert"
          data-testid="dependents-error"
        >
          <strong>{t.errorSummary}</strong>
          <p>{t[failure]}</p>
        </div>
      ) : null}
      {loadFailed ? (
        <div role="alert" data-testid="dependents-load-error">
          <p>{t.unavailable}</p>
          <Button
            variant="secondary"
            className="si-submit"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t.retry}
          </Button>
        </div>
      ) : items && items.length === 0 ? (
        <p data-testid="dependents-empty">{t.dependentsEmpty}</p>
      ) : items ? (
        <ul className="ac-dependents">
          {items.map((dependent) => (
            <li key={dependent.id} data-testid="dependent-row">
              {editing === dependent.id ? (
                <form onSubmit={(event) => rename(event, dependent.id)}>
                  <div className="si-field">
                    <label htmlFor={`dependent-name-${dependent.id}`}>
                      {t.dependentName}
                    </label>
                    <input
                      id={`dependent-name-${dependent.id}`}
                      name="displayName"
                      type="text"
                      required
                      maxLength={160}
                      defaultValue={dependent.displayName}
                      autoFocus
                    />
                  </div>
                  <Button type="submit" variant="primary" disabled={pending}>
                    {t.dependentSave}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => setEditing(null)}
                  >
                    {t.dependentCancel}
                  </Button>
                </form>
              ) : (
                <>
                  <span className="ac-dependent-name">
                    {dependent.displayName}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={pending}
                    aria-label={`${t.dependentRename} ${dependent.displayName}`}
                    onClick={() => setEditing(dependent.id)}
                  >
                    {t.dependentRename}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={pending}
                    aria-label={`${t.dependentArchive} ${dependent.displayName}`}
                    onClick={() =>
                      void send(
                        `/api/patient/dependents/${encodeURIComponent(dependent.id)}/archive`,
                        'POST',
                        null,
                      )
                    }
                  >
                    {t.dependentArchive}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={add} noValidate>
        <div className="si-field">
          <label htmlFor="dependent-new-name">{t.dependentName}</label>
          <input
            id="dependent-new-name"
            name="displayName"
            type="text"
            required
            maxLength={160}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          className="si-submit"
          disabled={pending}
        >
          {pending ? t.submitting : t.dependentAdd}
        </Button>
      </form>
    </section>
  );
}
