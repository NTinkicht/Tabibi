'use client';

import { useEffect, useRef, useState } from 'react';
import { safeReturnPath } from './return-path';
import { signInStrings, type SignInLocale } from './strings';

type FailureKey = 'failed' | 'rateLimited' | 'unavailable' | 'noClinic';

export function SignInForm({
  initialLocale,
  returnTo,
}: {
  initialLocale: SignInLocale;
  returnTo: string | null;
}) {
  const [locale, setLocale] = useState<SignInLocale>(initialLocale);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<FailureKey | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const t = signInStrings[locale];

  useEffect(() => {
    if (failure) summaryRef.current?.focus();
  }, [failure]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch('/api/staff/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: String(form.get('subject') ?? ''),
          password: String(form.get('password') ?? ''),
        }),
      });
      if (response.status === 429) return setFailure('rateLimited');
      if (response.status >= 500) return setFailure('unavailable');
      if (!response.ok) return setFailure('failed');
      const body = (await response.json()) as {
        memberships?: { clinicId: string }[];
      };
      const target =
        safeReturnPath(returnTo) ??
        (body.memberships?.[0]
          ? `/operations/${encodeURIComponent(body.memberships[0].clinicId)}`
          : null);
      if (!target) return setFailure('noClinic');
      const url = new URL(target, window.location.origin);
      url.searchParams.set('locale', locale);
      window.location.href = `${url.pathname}${url.search}`;
    } catch {
      setFailure('unavailable');
    } finally {
      setPending(false);
    }
  }

  return (
    <main
      className="pageShell"
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      data-testid="staff-sign-in"
    >
      <h1>{t.title}</h1>
      <p>{t.subtitle}</p>
      {failure ? (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          data-testid="sign-in-error"
        >
          <strong>{t.errorSummary}</strong>
          <p>{t[failure]}</p>
        </div>
      ) : null}
      <form onSubmit={submit} method="post" action="#" noValidate>
        <p>
          <label htmlFor="staff-subject">{t.subject}</label>
          <br />
          <input
            id="staff-subject"
            name="subject"
            type="text"
            autoComplete="username"
            required
            maxLength={320}
            dir="ltr"
          />
        </p>
        <p>
          <label htmlFor="staff-password">{t.password}</label>
          <br />
          <input
            id="staff-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            dir="ltr"
          />
        </p>
        <button type="submit" disabled={pending}>
          {pending ? t.submitting : t.submit}
        </button>
      </form>
      <p>
        <button
          type="button"
          lang={locale === 'ar' ? 'fr' : 'ar'}
          onClick={() => setLocale(locale === 'ar' ? 'fr' : 'ar')}
        >
          {t.otherLanguage}
        </button>
      </p>
    </main>
  );
}
