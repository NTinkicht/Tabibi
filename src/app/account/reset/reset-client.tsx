'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import '../../staff/sign-in/sign-in.css';
import '../account.css';
import { Button } from '@/app/ui';
import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import { accountStrings, type AccountLocale } from '../strings';

type Outcome =
  | 'done'
  | 'resetInvalidToken'
  | 'resetPolicy'
  | 'rateLimited'
  | 'unavailable';

// TAB-P1-01: redeem an operator-issued reset link. The token travels only in
// the URL fragment (never sent to the server on navigation or logged); it is
// moved into memory and removed from the address bar on load, and is sent only
// in the POST body.
export function ResetClient({
  initialLocale,
}: {
  initialLocale: AccountLocale;
}) {
  const [locale, setLocale] = useState<AccountLocale>(initialLocale);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const token = useRef('');
  const summaryRef = useRef<HTMLDivElement>(null);
  const t = accountStrings[locale];

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    token.current = fragment;
    if (fragment) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
    }
    // Deferred so the state update is not synchronous inside the effect.
    void Promise.resolve().then(() => {
      if (!fragment) setOutcome('resetInvalidToken');
      setReady(true);
    });
  }, []);

  const failed = outcome !== null && outcome !== 'done';
  useEffect(() => {
    if (failed) summaryRef.current?.focus();
  }, [failed, outcome]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !token.current) return;
    const form = event.currentTarget;
    const newPassword = String(new FormData(form).get('newPassword') ?? '');
    setPending(true);
    setOutcome(null);
    try {
      const response = await fetch('/api/patient/recovery/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.current, newPassword }),
      });
      if (response.status === 200) {
        token.current = '';
        form.reset();
        return setOutcome('done');
      }
      if (response.status === 429) return setOutcome('rateLimited');
      if (response.status === 400) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        return setOutcome(
          body.error === 'password_policy'
            ? 'resetPolicy'
            : 'resetInvalidToken',
        );
      }
      setOutcome('unavailable');
    } catch {
      setOutcome('unavailable');
    } finally {
      setPending(false);
    }
  }

  const showForm =
    ready && outcome !== 'done' && outcome !== 'resetInvalidToken';
  return (
    <main
      className="si"
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      data-testid="patient-reset"
    >
      <DocumentLocaleSync locale={locale} />
      <div className="si-card">
        <p className="si-brand" lang="fr" dir="ltr">
          Tabibi
        </p>
        <h1>{t.resetTitle}</h1>
        {failed ? (
          <div
            ref={summaryRef}
            className="si-error"
            tabIndex={-1}
            role="alert"
            data-testid="reset-error"
          >
            <strong>{t.errorSummary}</strong>
            <p>{t[outcome as Exclude<Outcome, 'done'>]}</p>
          </div>
        ) : null}
        {outcome === 'done' ? (
          <p role="status" className="ac-notice" data-testid="reset-notice">
            {t.resetDone}
          </p>
        ) : null}
        {showForm ? (
          <form onSubmit={submit} method="post" action="#" noValidate>
            <div className="si-field">
              <label htmlFor="reset-new-password">{t.newPassword}</label>
              <input
                id="reset-new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                maxLength={1024}
                dir="ltr"
                aria-invalid={outcome === 'resetPolicy' || undefined}
                aria-describedby="reset-new-password-hint"
              />
              <small id="reset-new-password-hint">{t.passwordHint}</small>
            </div>
            <Button
              type="submit"
              variant="primary"
              className="si-submit"
              disabled={pending}
            >
              {pending ? t.submitting : t.resetSubmit}
            </Button>
          </form>
        ) : null}
        {outcome === 'done' ? (
          <Link href={`/account?locale=${locale}`}>{t.resetGoSignIn}</Link>
        ) : null}
      </div>
      <button
        type="button"
        className="si-language"
        lang={locale === 'ar' ? 'fr' : 'ar'}
        onClick={() => setLocale(locale === 'ar' ? 'fr' : 'ar')}
      >
        {t.otherLanguage}
      </button>
    </main>
  );
}
