'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/app/ui';
import { accountStrings, type AccountLocale } from './strings';

type Outcome =
  | 'changed'
  | 'wrongCurrent'
  | 'policy'
  | 'rateLimited'
  | 'unavailable';

function classify(status: number): Outcome {
  if (status === 200) return 'changed';
  if (status === 403) return 'wrongCurrent';
  if (status === 400) return 'policy';
  if (status === 429) return 'rateLimited';
  return 'unavailable';
}

// TAB-P1-01: signed-in password change over POST /api/patient/password. Both
// passwords are read from the form only at submit and are never stored,
// logged or placed in the URL.
export function PasswordChangeForm({ locale }: { locale: AccountLocale }) {
  const t = accountStrings[locale];
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const failed = outcome !== null && outcome !== 'changed';

  useEffect(() => {
    if (failed) summaryRef.current?.focus();
  }, [failed, outcome]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setOutcome(null);
    try {
      const response = await fetch('/api/patient/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          currentPassword: String(data.get('currentPassword') ?? ''),
          newPassword: String(data.get('newPassword') ?? ''),
        }),
      });
      const next = classify(response.status);
      if (next === 'changed') form.reset();
      setOutcome(next);
    } catch {
      setOutcome('unavailable');
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="account-password-title"
      data-testid="password-change"
    >
      <h2 id="account-password-title">{t.changePasswordTitle}</h2>
      {failed ? (
        <div
          ref={summaryRef}
          className="si-error"
          tabIndex={-1}
          role="alert"
          data-testid="password-error"
        >
          <strong>{t.errorSummary}</strong>
          <p>{t[outcome as Exclude<Outcome, 'changed'>]}</p>
        </div>
      ) : null}
      {outcome === 'changed' ? (
        <p role="status" className="ac-notice" data-testid="password-notice">
          {t.passwordChanged}
        </p>
      ) : null}
      <form onSubmit={submit} method="post" action="#" noValidate>
        <div className="si-field">
          <label htmlFor="account-current-password">{t.currentPassword}</label>
          <input
            id="account-current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            dir="ltr"
            aria-invalid={outcome === 'wrongCurrent' || undefined}
          />
        </div>
        <div className="si-field">
          <label htmlFor="account-new-password">{t.newPassword}</label>
          <input
            id="account-new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            maxLength={1024}
            dir="ltr"
            aria-invalid={outcome === 'policy' || undefined}
            aria-describedby="account-new-password-hint"
          />
          <small id="account-new-password-hint">{t.passwordHint}</small>
        </div>
        <Button
          type="submit"
          variant="primary"
          className="si-submit"
          disabled={pending}
        >
          {pending ? t.submitting : t.changePassword}
        </Button>
      </form>
    </section>
  );
}
