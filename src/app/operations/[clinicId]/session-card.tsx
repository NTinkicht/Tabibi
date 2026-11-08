'use client';
import Link from 'next/link';
import { Button, Chip } from '@/app/ui';
import {
  countsLine,
  formatClock,
  statusTone,
  type HomeCopy,
  type QueueCounts,
  type SessionStatus,
} from '@/modules/receptionist-dashboard/home-view';

export type HomeSession = {
  id: string;
  doctorId: string;
  doctorDisplayName: string;
  startsAt: string;
  endsAt: string;
  status: SessionStatus;
  openedAt: string | null;
  closedAt: string | null;
  declaredDelayMinutes: number | null;
  delayVersion: number;
  queueCounts?: QueueCounts;
};

export type SessionCardProps = {
  session: HomeSession;
  clinicId: string;
  t: HomeCopy;
  locale: 'ar' | 'fr';
  timezone: string;
  pending: boolean;
  delayValue: string;
  onCommand: (session: HomeSession, command: string) => void;
  onDelayChange: (sessionId: string, value: string) => void;
  onDelaySubmit: (
    event: React.FormEvent<HTMLFormElement>,
    session: HomeSession,
  ) => void;
  onClearDelay: (session: HomeSession) => void;
};

/**
 * One session card of the reception home (docs/design/reception-home.md).
 * Presentational: every action calls back into the existing command flows.
 */
export function SessionCard(props: SessionCardProps) {
  const { session, clinicId, t, locale, timezone, pending } = props;
  const status = session.status;
  const live = status === 'open' || status === 'paused';
  const finished = status === 'closed' || status === 'cancelled';
  const consoleHref = `/operations/${clinicId}/sessions/${session.id}/queue?locale=${locale}`;
  const clock = (instant: string) => (
    <bdi>{formatClock(instant, locale, timezone)}</bdi>
  );
  return (
    <article
      className={`rh-card rh-card--${status}`}
      aria-labelledby={`rh-doctor-${session.id}`}
    >
      <div className="rh-card__top">
        <div>
          <h2 id={`rh-doctor-${session.id}`}>{session.doctorDisplayName}</h2>
          <p className="rh-card__hours">
            {clock(session.startsAt)} — {clock(session.endsAt)}
          </p>
        </div>
        <div className="rh-card__chips">
          <Chip tone={statusTone(status)}>{t.statuses[status]}</Chip>
          {session.declaredDelayMinutes !== null && (
            <Chip tone="warning">
              +{session.declaredDelayMinutes} {t.minutes}
            </Chip>
          )}
        </div>
      </div>
      <p className="rh-card__meta">
        {session.openedAt && (
          <span>
            {t.homeOpenedAt.replace(
              '{time}',
              formatClock(session.openedAt, locale, timezone),
            )}
          </span>
        )}
        {session.closedAt && (
          <span>
            {t.homeClosedAt.replace(
              '{time}',
              formatClock(session.closedAt, locale, timezone),
            )}
          </span>
        )}
      </p>
      <p className="rh-card__counts">{countsLine(session.queueCounts, t)}</p>
      <div className="rh-card__actions">
        {live && (
          <Link
            className="tb-button tb-button--primary rh-link"
            href={consoleHref}
          >
            {t.homeOpenConsole}
          </Link>
        )}
        {status === 'planned' && (
          <Button onClick={() => props.onCommand(session, 'open')}>
            {t.homeOpenSession}
          </Button>
        )}
        {status === 'open' && (
          <Button
            variant="secondary"
            onClick={() => props.onCommand(session, 'pause')}
          >
            {t.pause}
          </Button>
        )}
        {status === 'paused' && (
          <Button
            variant="secondary"
            onClick={() => props.onCommand(session, 'resume')}
          >
            {t.resume}
          </Button>
        )}
        {live && (
          <Button
            variant="danger"
            onClick={() => props.onCommand(session, 'close')}
          >
            {t.close}
          </Button>
        )}
        {!finished && (
          <Button
            variant="danger"
            onClick={() => props.onCommand(session, 'cancel')}
          >
            {t.cancel}
          </Button>
        )}
        {finished && (
          <Link
            className="tb-button tb-button--secondary rh-link"
            href={consoleHref}
          >
            {t.homeViewSummary}
          </Link>
        )}
      </div>
      {!finished && (
        <form
          className="rh-delay"
          onSubmit={(event) => props.onDelaySubmit(event, session)}
        >
          <label htmlFor={`delay-${session.id}`}>{t.delayMinutes}</label>
          <input
            id={`delay-${session.id}`}
            aria-describedby={`delay-hint-${session.id}`}
            type="number"
            inputMode="numeric"
            min="1"
            max="720"
            step="1"
            required
            value={props.delayValue}
            onChange={(event) =>
              props.onDelayChange(session.id, event.target.value)
            }
          />
          <span className="srOnly" id={`delay-hint-${session.id}`}>
            {t.delayRange}
          </span>
          <Button variant="secondary" type="submit">
            {t.delay}
          </Button>
          {session.declaredDelayMinutes !== null && (
            <Button
              variant="secondary"
              onClick={() => props.onClearDelay(session)}
            >
              {t.clear}
            </Button>
          )}
        </form>
      )}
      {pending && (
        <div className="rh-card__pending" aria-live="polite">
          {t.pending}
        </div>
      )}
    </article>
  );
}
