'use client';

import { useEffect, useRef, useState } from 'react';
import '../sign-in/sign-in.css';
import './invite.css';
import { Button } from '@/app/ui';
import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import { inviteStrings, type InviteLocale } from './strings';

type Preview = {
  clinicName: string;
  email: string;
  role: 'doctor' | 'receptionist';
  expiresAt: string;
};
type FailureKey =
  | 'invalid'
  | 'missing'
  | 'mismatch'
  | 'too_short'
  | 'too_long'
  | 'matches_identity'
  | 'invalidInput'
  | 'rateLimited'
  | 'unavailable';

function failureFor(status: number, body: unknown): FailureKey {
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'unavailable';
  const { error, code } = (body ?? {}) as { error?: string; code?: string };
  if (error === 'invite_invalid') return 'invalid';
  if (
    error === 'password_policy' &&
    (code === 'too_short' || code === 'too_long' || code === 'matches_identity')
  )
    return code;
  return 'invalidInput';
}

export function InviteForm({ initialLocale }: { initialLocale: InviteLocale }) {
  const [locale, setLocale] = useState<InviteLocale>(initialLocale);
  const token = useRef<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<FailureKey | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const t = inviteStrings[locale];
  const passwordInvalid =
    failure === 'too_short' ||
    failure === 'too_long' ||
    failure === 'matches_identity';
  const confirmInvalid = failure === 'mismatch';
  const nameInvalid = failure === 'invalidInput';

  useEffect(() => {
    // Keep the token in memory only and drop it from the address bar and
    // history at once.
    const fragment = window.location.hash.slice(1);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    token.current = fragment === '' ? null : fragment;
    let cancelled = false;
    (async () => {
      try {
        if (fragment === '') {
          setFailure('missing');
          return;
        }
        const response = await fetch('/api/staff/invites/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: fragment }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) setFailure(failureFor(response.status, body));
        else setPreview((body as { invite: Preview }).invite);
      } catch {
        if (!cancelled) setFailure('unavailable');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // A link pasted into this already-open page is a same-document fragment
    // change: reload so it is read like a fresh visit.
    const onHashChange = () => window.location.reload();
    window.addEventListener('hashchange', onHashChange);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  useEffect(() => {
    if (failure) summaryRef.current?.focus();
  }, [failure]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !token.current) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (password !== String(form.get('confirm') ?? ''))
      return setFailure('mismatch');
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch('/api/staff/invites/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: token.current,
          displayName: String(form.get('displayName') ?? ''),
          password,
        }),
      });
      if (response.ok) {
        token.current = null;
        setDone(true);
        return;
      }
      setFailure(
        failureFor(response.status, await response.json().catch(() => null)),
      );
    } catch {
      setFailure('unavailable');
    } finally {
      setPending(false);
    }
  }

  const dateFormat = new Intl.DateTimeFormat(
    locale === 'ar' ? 'ar-DZ' : 'fr-DZ',
    { dateStyle: 'long', timeStyle: 'short' },
  );

  return (
    <main
      className="si"
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      data-testid="staff-invite"
    >
      <DocumentLocaleSync locale={locale} />
      <div className="si-card">
        <p className="si-brand" lang="fr" dir="ltr">
          Tabibi
        </p>
        <h1>{done ? t.doneTitle : t.title}</h1>
        {failure ? (
          <div
            ref={summaryRef}
            className="si-error"
            tabIndex={-1}
            role="alert"
            data-testid="invite-error"
          >
            <strong>{t.errorSummary}</strong>
            <p>{t[failure]}</p>
          </div>
        ) : null}
        {loading ? (
          <p className="si-subtitle" aria-live="polite">
            {t.loading}
          </p>
        ) : null}
        {done ? (
          <>
            <p className="si-subtitle" data-testid="invite-done">
              {t.done}
            </p>
            <a className="si-link" href={`/staff/sign-in?locale=${locale}`}>
              {t.signIn}
            </a>
          </>
        ) : preview ? (
          <>
            <p className="si-subtitle" data-testid="invite-summary">
              {t.invitedAs(preview.clinicName, t.roles[preview.role])}
            </p>
            <dl className="si-facts">
              <dt>{t.email}</dt>
              <dd dir="ltr">{preview.email}</dd>
              <dt>{t.expires}</dt>
              <dd>{dateFormat.format(new Date(preview.expiresAt))}</dd>
            </dl>
            <form onSubmit={submit} method="post" action="#" noValidate>
              <div className="si-field">
                <label htmlFor="invite-name">{t.displayName}</label>
                <input
                  id="invite-name"
                  name="displayName"
                  type="text"
                  autoComplete="name"
                  required
                  maxLength={120}
                  aria-invalid={nameInvalid || undefined}
                />
              </div>
              <div className="si-field">
                <label htmlFor="invite-password">{t.password}</label>
                <input
                  id="invite-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  aria-describedby="invite-password-hint"
                  required
                  maxLength={256}
                  dir="ltr"
                  aria-invalid={passwordInvalid || undefined}
                />
                <small id="invite-password-hint" className="si-hint">
                  {t.passwordHint}
                </small>
              </div>
              <div className="si-field">
                <label htmlFor="invite-confirm">{t.confirm}</label>
                <input
                  id="invite-confirm"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  maxLength={256}
                  dir="ltr"
                  aria-invalid={confirmInvalid || undefined}
                />
              </div>
              <Button
                type="submit"
                variant="primary"
                className="si-submit"
                disabled={pending}
              >
                {pending ? t.submitting : t.submit}
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
