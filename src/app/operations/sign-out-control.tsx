'use client';

import { useState } from 'react';

// Bilingual on purpose: this control sits above pages that each own their
// locale, so both labels are shown and each is tagged with its language.
export function SignOutControl() {
  const [pending, setPending] = useState(false);
  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      await fetch('/api/staff/session/logout', { method: 'POST' });
    } finally {
      window.location.href = '/staff/sign-in';
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
    </nav>
  );
}
