'use client';

import { useState } from 'react';

// Bilingual on purpose: this control sits above pages that each own their
// locale, so both labels are shown and each is tagged with its language.
// The redirect happens only after the server confirms the session was
// revoked; on any failure the control stays usable so the user can retry.
export function SignOutControl() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signOut() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch('/api/staff/session/logout', {
        method: 'POST',
      });
      if (!response.ok) throw new Error('logout_failed');
      window.location.href = '/staff/sign-in';
    } catch {
      setFailed(true);
      setPending(false);
    }
  }
  return (
    <nav aria-label="Session" style={{ padding: '0.5rem 1rem' }}>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        data-testid="sign-out"
      >
        <span lang="fr">Se déconnecter</span> ·{' '}
        <span lang="ar" dir="rtl">
          تسجيل الخروج
        </span>
      </button>
      {failed ? (
        <p role="alert" data-testid="sign-out-error">
          <span lang="fr">Déconnexion impossible. Réessayez.</span>
          {' · '}
          <span lang="ar" dir="rtl">
            تعذّر تسجيل الخروج. حاول مرة أخرى.
          </span>
        </p>
      ) : null}
    </nav>
  );
}
