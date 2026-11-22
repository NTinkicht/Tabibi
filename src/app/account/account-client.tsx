'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import '../staff/sign-in/sign-in.css';
import './account.css';
import { Button } from '@/app/ui';
import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import { DependentsSection } from './dependents-section';
import { SavedDoctorsSection } from './saved-doctors-section';
import { VisitsSection } from './visits-section';
import { PasswordChangeForm } from './password-change-form';
import { accountStrings, type AccountLocale } from './strings';

type Mode = 'signIn' | 'register';
type FailureKey = 'failed' | 'invalid' | 'rateLimited' | 'unavailable';

// TAB-P1-01: patient registration, sign-in and sign-out over the existing
// /api/patient routes. The session lives only in the server's HttpOnly cookie;
// nothing secret is placed in the URL, DOM or browser storage.
export function AccountClient({
  initialLocale,
}: {
  initialLocale: AccountLocale;
}) {
  const [locale, setLocale] = useState<AccountLocale>(initialLocale);
  const [mode, setMode] = useState<Mode>('signIn');
  const [account, setAccount] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FailureKey | null>(null);
  const [notice, setNotice] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const t = accountStrings[locale];

  const [checkFailed, setCheckFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Only a 401 means "signed out". Network errors and 5xx are surfaced with a
  // retry path so a valid session is never presented as absent.
  useEffect(() => {
    let live = true;
    fetch('/api/patient/session')
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) {
          setCheckFailed(false);
          setChecked(true);
          return;
        }
        if (!response.ok) throw new Error('session-check-failed');
        const body = (await response.json()) as {
          account?: { displayName?: string };
        };
        setAccount(body.account?.displayName ?? '');
        setCheckFailed(false);
        setChecked(true);
      })
      .catch(() => {
        if (live) setCheckFailed(true);
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (failure) summaryRef.current?.focus();
  }, [failure]);

  function classify(status: number): FailureKey {
    if (status === 429) return 'rateLimited';
    if (status >= 500) return 'unavailable';
    return mode === 'register' ? 'invalid' : 'failed';
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    setPending(true);
    setFailure(null);
    setNotice(false);
    try {
      const registering = mode === 'register';
      const response = await fetch(
        registering ? '/api/patient/register' : '/api/patient/session',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            registering
              ? {
                  email,
                  password,
                  displayName: String(form.get('displayName') ?? ''),
                }
              : { email, password },
          ),
        },
      );
      if (!response.ok) return setFailure(classify(response.status));
      if (registering) {
        setMode('signIn');
        return setNotice(true);
      }
      const body = (await response.json()) as {
        account?: { displayName?: string };
      };
      setAccount(body.account?.displayName ?? '');
    } catch {
      setFailure('unavailable');
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      const response = await fetch('/api/patient/session/logout', {
        method: 'POST',
      });
      if (response.ok) setAccount(null);
      else setFailure(classify(response.status));
    } catch {
      setFailure('unavailable');
    } finally {
      setPending(false);
    }
  }

  const signedOut = useCallback(() => setAccount(null), []);
  const invalid = failure === 'failed' || failure === 'invalid';
  const registering = mode === 'register';
  return (
    <main
      className="si"
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      data-testid="patient-account"
    >
      <DocumentLocaleSync locale={locale} />
      <div className="si-card">
        <p className="si-brand" lang="fr" dir="ltr">
          Tabibi
        </p>
        <h1>{t.title}</h1>
        {failure ? (
          <div
            ref={summaryRef}
            className="si-error"
            tabIndex={-1}
            role="alert"
            data-testid="account-error"
          >
            <strong>{t.errorSummary}</strong>
            <p>{t[failure]}</p>
          </div>
        ) : null}
        {checkFailed ? (
          <div role="alert" data-testid="account-session-error">
            <p>{t.unavailable}</p>
            <Button
              variant="secondary"
              className="si-submit"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t.retry}
            </Button>
          </div>
        ) : account !== null ? (
          <div data-testid="account-signed-in">
            <p className="si-subtitle">
              {t.signedInAs} <strong>{account}</strong>
            </p>
            <Button
              variant="secondary"
              className="si-submit"
              disabled={pending}
              onClick={signOut}
            >
              {t.signOut}
            </Button>
            <DependentsSection locale={locale} onSignedOut={signedOut} />
            <VisitsSection locale={locale} onSignedOut={signedOut} />
            <SavedDoctorsSection locale={locale} onSignedOut={signedOut} />
            <PasswordChangeForm locale={locale} />
          </div>
        ) : checked ? (
          <>
            <p className="si-subtitle">{t.subtitleOut}</p>
            <div className="ac-tabs">
              <button
                type="button"
                aria-pressed={!registering}
                onClick={() => {
                  setMode('signIn');
                  setFailure(null);
                }}
              >
                {t.signInTab}
              </button>
              <button
                type="button"
                aria-pressed={registering}
                onClick={() => {
                  setMode('register');
                  setFailure(null);
                  setNotice(false);
                }}
              >
                {t.registerTab}
              </button>
            </div>
            {notice ? (
              <p
                role="status"
                className="ac-notice"
                data-testid="account-notice"
              >
                {t.registered}
              </p>
            ) : null}
            <form
              key={mode}
              onSubmit={submit}
              method="post"
              action="#"
              noValidate
            >
              <div className="si-field">
                <label htmlFor="account-email">{t.email}</label>
                <input
                  id="account-email"
                  name="email"
                  type="email"
                  autoComplete={registering ? 'email' : 'username'}
                  required
                  maxLength={320}
                  dir="ltr"
                  aria-invalid={invalid || undefined}
                />
              </div>
              {registering ? (
                <div className="si-field">
                  <label htmlFor="account-name">{t.displayName}</label>
                  <input
                    id="account-name"
                    name="displayName"
                    type="text"
                    autoComplete="name"
                    required
                    maxLength={160}
                  />
                </div>
              ) : null}
              <div className="si-field">
                <label htmlFor="account-password">{t.password}</label>
                <input
                  id="account-password"
                  name="password"
                  type="password"
                  autoComplete={
                    registering ? 'new-password' : 'current-password'
                  }
                  required
                  maxLength={1024}
                  dir="ltr"
                  aria-invalid={invalid || undefined}
                  aria-describedby={
                    registering ? 'account-password-hint' : undefined
                  }
                />
                {registering ? (
                  <small id="account-password-hint">{t.passwordHint}</small>
                ) : null}
              </div>
              <Button
                type="submit"
                variant="primary"
                className="si-submit"
                disabled={pending}
              >
                {pending ? t.submitting : registering ? t.register : t.signIn}
              </Button>
            </form>
          </>
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
