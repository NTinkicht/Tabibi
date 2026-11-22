'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/app/ui';
import { accountStrings, type AccountLocale } from './strings';

interface SavedDoctor {
  clinicId: string;
  doctorId: string;
  clinicName: string;
  displayName: string;
}
type Failure = 'rateLimited' | 'unavailable';

// Strict parse of the documented response shape; anything else is a load
// failure rather than a partial list.
function parseList(body: unknown): SavedDoctor[] | null {
  const list = (body as { doctors?: unknown })?.doctors;
  if (!Array.isArray(list)) return null;
  const parsed: SavedDoctor[] = [];
  for (const item of list) {
    const { clinicId, doctorId, clinicName, displayName, savedAt } = (item ??
      {}) as Record<string, unknown>;
    if (
      typeof clinicId !== 'string' ||
      typeof doctorId !== 'string' ||
      typeof clinicName !== 'string' ||
      typeof displayName !== 'string' ||
      typeof savedAt !== 'string'
    )
      return null;
    parsed.push({ clinicId, doctorId, clinicName, displayName });
  }
  return parsed;
}

// TAB-P1-04: the signed-in patient's saved doctors over the owner-scoped
// /api/patient/saved-doctors routes. The owner is always the session; the
// client sends no identity. A 401 returns the page to the signed-out state.
export function SavedDoctorsSection({
  locale,
  onSignedOut,
}: {
  locale: AccountLocale;
  onSignedOut: () => void;
}) {
  const t = accountStrings[locale];
  const [items, setItems] = useState<SavedDoctor[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/patient/saved-doctors')
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) return onSignedOut();
        const parsed = response.ok ? parseList(await response.json()) : null;
        if (!parsed) throw new Error('saved-doctors-load-failed');
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

  async function remove(doctor: SavedDoctor) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(
        `/api/patient/saved-doctors/${encodeURIComponent(doctor.clinicId)}/${encodeURIComponent(doctor.doctorId)}`,
        { method: 'DELETE' },
      );
      if (response.status === 401) return onSignedOut();
      if (!response.ok) {
        setFailure(response.status === 429 ? 'rateLimited' : 'unavailable');
        return;
      }
      setAttempt((n) => n + 1);
    } catch {
      setFailure('unavailable');
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="account-saved-doctors-title"
      data-testid="saved-doctors"
    >
      <h2 id="account-saved-doctors-title">{t.savedDoctorsTitle}</h2>
      <p className="si-subtitle">{t.savedDoctorsHint}</p>
      {failure ? (
        <div
          ref={summaryRef}
          className="si-error"
          tabIndex={-1}
          role="alert"
          data-testid="saved-doctors-error"
        >
          <strong>{t.errorSummary}</strong>
          <p>{t[failure]}</p>
        </div>
      ) : null}
      {loadFailed ? (
        <div role="alert" data-testid="saved-doctors-load-error">
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
        <p data-testid="saved-doctors-empty">{t.savedDoctorsEmpty}</p>
      ) : items ? (
        <ul className="ac-dependents">
          {items.map((doctor) => (
            <li
              key={`${doctor.clinicId}:${doctor.doctorId}`}
              data-testid="saved-doctor-row"
            >
              <span className="ac-dependent-name">
                {doctor.displayName}
                <small className="ac-saved-clinic">{doctor.clinicName}</small>
              </span>
              <Button
                variant="secondary"
                disabled={pending}
                aria-label={`${t.savedDoctorRemove} ${doctor.displayName}`}
                onClick={() => void remove(doctor)}
              >
                {t.savedDoctorRemove}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
