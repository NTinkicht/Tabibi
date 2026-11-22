'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/app/ui';
import { accountStrings, type AccountLocale } from './strings';

type VisitStatus =
  | 'booked'
  | 'confirmed'
  | 'checked_in'
  | 'completed'
  | 'cancelled'
  | 'no_show';
const STATUSES: readonly string[] = [
  'booked',
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'no_show',
];

interface Visit {
  appointmentId: string;
  clinicName: string;
  doctorDisplayName: string;
  scheduledStartAt: string;
  status: VisitStatus;
  forRelative: boolean;
}
interface Page {
  visits: Visit[];
  nextCursor: string | null;
}
type Failure = 'rateLimited' | 'unavailable' | 'visitCancelConflict';

// Strict parse of the documented response shape; anything else is a load
// failure rather than a partial list.
function parsePage(body: unknown): Page | null {
  const { visits, nextCursor } = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(visits)) return null;
  if (nextCursor !== null && typeof nextCursor !== 'string') return null;
  const parsed: Visit[] = [];
  for (const item of visits) {
    const {
      appointmentId,
      clinicName,
      doctorDisplayName,
      scheduledStartAt,
      status,
      dependentId,
    } = (item ?? {}) as Record<string, unknown>;
    if (
      typeof appointmentId !== 'string' ||
      typeof clinicName !== 'string' ||
      typeof doctorDisplayName !== 'string' ||
      typeof scheduledStartAt !== 'string' ||
      Number.isNaN(Date.parse(scheduledStartAt)) ||
      typeof status !== 'string' ||
      !STATUSES.includes(status) ||
      (dependentId !== null && typeof dependentId !== 'string')
    )
      return null;
    parsed.push({
      appointmentId,
      clinicName,
      doctorDisplayName,
      scheduledStartAt,
      status: status as VisitStatus,
      forRelative: dependentId !== null,
    });
  }
  return { visits: parsed, nextCursor: nextCursor ?? null };
}

async function fetchPage(
  cursor: string | null,
): Promise<Page | 'unauthorized'> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await fetch(`/api/patient/visits${query}`);
  if (response.status === 401) return 'unauthorized';
  const page = response.ok ? parsePage(await response.json()) : null;
  if (!page) throw new Error('visits-load-failed');
  return page;
}

// Algeria has a single civil time zone without DST; showing it explicitly
// keeps the displayed time independent of the device's zone.
function formatStart(iso: string, locale: AccountLocale): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-DZ' : 'fr-DZ', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Algiers',
  }).format(new Date(iso));
}

// TAB-P1-04: the signed-in patient's operational visit history and
// cancellation of upcoming visits over the owner-scoped /api/patient/visits
// routes. The owner is always the session; the client sends no identity. A 401
// returns the page to the signed-out state.
export function VisitsSection({
  locale,
  onSignedOut,
}: {
  locale: AccountLocale;
  onSignedOut: () => void;
}) {
  const t = accountStrings[locale];
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fetchPage(null)
      .then((result) => {
        if (!live) return;
        if (result === 'unauthorized') return onSignedOut();
        setVisits(result.visits);
        setNextCursor(result.nextCursor);
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

  async function loadMore() {
    if (pending || !nextCursor) return;
    setPending(true);
    try {
      const result = await fetchPage(nextCursor);
      if (result === 'unauthorized') return onSignedOut();
      setVisits((previous) => [...(previous ?? []), ...result.visits]);
      setNextCursor(result.nextCursor);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setPending(false);
    }
  }

  async function cancel(visit: Visit) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(
        `/api/patient/visits/${encodeURIComponent(visit.appointmentId)}/cancel`,
        { method: 'POST' },
      );
      if (response.status === 401) return onSignedOut();
      if (response.status === 409) {
        setFailure('visitCancelConflict');
        setConfirming(null);
        setAttempt((n) => n + 1);
        return;
      }
      if (!response.ok) {
        setFailure(response.status === 429 ? 'rateLimited' : 'unavailable');
        return;
      }
      setConfirming(null);
      setAttempt((n) => n + 1);
    } catch {
      setFailure('unavailable');
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="account-visits-title" data-testid="visits">
      <h2 id="account-visits-title">{t.visitsTitle}</h2>
      <p className="si-subtitle">{t.visitsHint}</p>
      {failure ? (
        <div
          ref={summaryRef}
          className="si-error"
          tabIndex={-1}
          role="alert"
          data-testid="visits-error"
        >
          <strong>{t.errorSummary}</strong>
          <p>{t[failure]}</p>
        </div>
      ) : null}
      {loadFailed && visits === null ? (
        <div role="alert" data-testid="visits-load-error">
          <p>{t.unavailable}</p>
          <Button
            variant="secondary"
            className="si-submit"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t.retry}
          </Button>
        </div>
      ) : visits && visits.length === 0 ? (
        <p data-testid="visits-empty">{t.visitsEmpty}</p>
      ) : visits ? (
        <>
          <ul className="ac-dependents">
            {visits.map((visit) => {
              const cancellable =
                visit.status === 'booked' || visit.status === 'confirmed';
              const label = `${visit.doctorDisplayName}, ${formatStart(visit.scheduledStartAt, locale)}`;
              return (
                <li key={visit.appointmentId} data-testid="visit-row">
                  <span className="ac-dependent-name">
                    {visit.doctorDisplayName}
                    <small className="ac-saved-clinic">
                      {visit.clinicName}
                    </small>
                    <small className="ac-saved-clinic">
                      <time dateTime={visit.scheduledStartAt}>
                        {formatStart(visit.scheduledStartAt, locale)}
                      </time>
                      {' · '}
                      <span data-testid="visit-status">
                        {t.visitStatus[visit.status]}
                      </span>
                      {visit.forRelative ? ` · ${t.visitForRelative}` : ''}
                    </small>
                  </span>
                  {cancellable && confirming !== visit.appointmentId ? (
                    <Button
                      variant="secondary"
                      disabled={pending}
                      aria-label={`${t.visitCancel} ${label}`}
                      onClick={() => {
                        setFailure(null);
                        setConfirming(visit.appointmentId);
                      }}
                    >
                      {t.visitCancel}
                    </Button>
                  ) : null}
                  {cancellable && confirming === visit.appointmentId ? (
                    <>
                      <Button
                        variant="secondary"
                        disabled={pending}
                        aria-label={`${t.visitCancelConfirm} ${label}`}
                        onClick={() => void cancel(visit)}
                      >
                        {t.visitCancelConfirm}
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={pending}
                        onClick={() => setConfirming(null)}
                      >
                        {t.visitCancelKeep}
                      </Button>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {loadFailed ? (
            <p role="alert" data-testid="visits-more-error">
              {t.unavailable}
            </p>
          ) : null}
          {nextCursor ? (
            <Button
              variant="secondary"
              className="si-submit"
              disabled={pending}
              onClick={() => void loadMore()}
            >
              {t.visitsMore}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
