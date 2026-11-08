'use client';

import { receptionistCopy } from '@/modules/localization/receptionist';
import {
  CONSOLE_DELAY_MAX_MINUTES,
  steppedDelay,
  type ConsoleEntry,
} from '@/modules/receptionist-dashboard/console-view';

type Copy = (typeof receptionistCopy)['fr'] | (typeof receptionistCopy)['ar'];

export interface SessionBarProps {
  t: Copy;
  status: 'planned' | 'open' | 'paused' | 'closed' | 'cancelled';
  declaredDelayMinutes: number | null;
  nextCallable: ConsoleEntry | null;
  callNextEnabled: boolean;
  busy: boolean;
  onCallNext: () => void;
  onDelay: (minutes: number) => void;
  onSessionCommand: (command: 'pause' | 'resume' | 'close') => void;
}

/**
 * Session bar of the reception console (docs/design/reception-console.md).
 * Every control issues exactly one existing command; the committed value is
 * rendered only after the server confirms (the parent reloads the dashboard).
 */
export function SessionBar(props: SessionBarProps) {
  const { t, status, declaredDelayMinutes, nextCallable, busy } = props;
  const delay = declaredDelayMinutes ?? 0;
  const live = status === 'open' || status === 'paused';
  const callLabel = nextCallable
    ? `${t.callNext} · ${nextCallable.publicDisplayLabel} ${nextCallable.privateDisplayName}`
    : t.noneToCall;
  return (
    <>
      <section className="sessionBar" aria-label={t.sessionState}>
        <div className="delayStepper" role="group" aria-label={t.delay}>
          <button
            type="button"
            aria-label={`${t.delay} −`}
            disabled={busy || !live || delay <= 0}
            onClick={() => props.onDelay(steppedDelay(delay, -1))}
          >
            −
          </button>
          <span aria-live="polite" className="delayValue">
            {delay > 0 ? `${delay} ${t.minutes}` : t.noDelay}
          </span>
          <button
            type="button"
            aria-label={`${t.delay} +`}
            disabled={busy || !live || delay >= CONSOLE_DELAY_MAX_MINUTES}
            onClick={() => props.onDelay(steppedDelay(delay, 1))}
          >
            +
          </button>
        </div>
        <div className="sessionActions">
          {status === 'open' && (
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => props.onSessionCommand('pause')}
            >
              {t.pause}
            </button>
          )}
          {status === 'paused' && (
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => props.onSessionCommand('resume')}
            >
              {t.resume}
            </button>
          )}
          {live && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => props.onSessionCommand('close')}
            >
              {t.close}
            </button>
          )}
        </div>
        <button
          type="button"
          className="callNext"
          disabled={busy || !props.callNextEnabled}
          onClick={props.onCallNext}
        >
          {callLabel}
        </button>
      </section>
      {status === 'paused' && (
        <div className="pausedBanner" role="status">
          {t.pausedBanner}
        </div>
      )}
    </>
  );
}
