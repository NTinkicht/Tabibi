'use client';

import { useState } from 'react';
import { receptionistCopy } from '@/modules/localization/receptionist';
import {
  formatWaitRange,
  type ConsoleEntry,
  type ConsoleRow,
} from '@/modules/receptionist-dashboard/console-view';
import type { QueueCommand } from '@/modules/queue/lifecycle-contract';

type Copy = (typeof receptionistCopy)['fr'] | (typeof receptionistCopy)['ar'];
export type PanelAction = 'prioritise' | 'no_show' | 'cancel';

export interface RegionHandlers {
  t: Copy;
  locale: 'ar' | 'fr';
  /** True while any command is in flight or the snapshot is stale. */
  busy: boolean;
  pendingEntryId: string | null;
  onPrimary: (entry: ConsoleEntry, command: QueueCommand) => void;
  onPanel: (entry: ConsoleEntry, action: PanelAction, reason: string) => void;
}

const PRIMARY_LABEL: Partial<Record<QueueCommand, keyof Copy>> = {
  check_in: 'checkIn',
  call: 'call',
  start_consultation: 'startConsultation',
  complete_consultation: 'completeConsultation',
};
const PANEL_LABEL: Record<PanelAction, keyof Copy> = {
  prioritise: 'prioritise',
  no_show: 'noShow',
  cancel: 'cancelEntry',
};

function entryMeta(entry: ConsoleEntry, h: RegionHandlers): string {
  const parts: string[] = [];
  if (entry.origin === 'appointment' && entry.appointmentStartsAt) {
    const time = new Date(entry.appointmentStartsAt).toLocaleTimeString(
      h.locale === 'ar' ? 'ar-DZ' : 'fr-DZ',
      { hour: '2-digit', minute: '2-digit' },
    );
    parts.push(h.t.appointmentMeta.replace('{time}', time));
  } else {
    parts.push(h.t.walkInMeta);
  }
  parts.push(entry.hasContact ? h.t.phoneOnFile : h.t.noContact);
  return parts.join(' · ');
}

function ReasonPanel({ row, h }: { row: ConsoleRow; h: RegionHandlers }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { entry } = row;
  if (row.actions.panel.length === 0) return null;
  const panelId = `panel-${entry.id}`;
  const close = () => {
    setOpen(false);
    setReason('');
  };
  return (
    <div
      className="rowPanelWrap"
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      <button
        type="button"
        className="quiet moreButton"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={h.t.moreActionsFor.replace(
          '{ticket}',
          entry.publicDisplayLabel,
        )}
        disabled={h.busy}
        onClick={() => (open ? close() : setOpen(true))}
      >
        ⋯
      </button>
      {open && (
        <div className="rowPanel" id={panelId}>
          <label>
            {h.t.queueReason}
            <input
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="rowPanelActions">
            {row.actions.panel.map((action) => (
              <button
                key={action}
                type="button"
                className={action === 'cancel' ? 'danger' : 'quiet'}
                disabled={h.busy || reason.trim() === ''}
                onClick={() => {
                  h.onPanel(entry, action, reason.trim());
                  close();
                }}
              >
                {h.t[PANEL_LABEL[action]] as string}
              </button>
            ))}
          </div>
          <small>{h.t.auditedHint}</small>
        </div>
      )}
    </div>
  );
}

function PrimaryButton({
  row,
  h,
  emphasised,
}: {
  row: ConsoleRow;
  h: RegionHandlers;
  emphasised: boolean;
}) {
  const command = row.actions.primary;
  if (command === null) return null;
  const label = h.t[PRIMARY_LABEL[command]!] as string;
  return (
    <button
      type="button"
      className={emphasised ? 'primaryAction' : 'quiet'}
      disabled={h.busy || row.actions.primaryDisabled}
      onClick={() => h.onPrimary(row.entry, command)}
    >
      {h.pendingEntryId === row.entry.id ? h.t.pending : label}
    </button>
  );
}

export function ServingCards({
  rows,
  h,
}: {
  rows: ConsoleRow[];
  h: RegionHandlers;
}) {
  return (
    <section className="servingRegion" aria-labelledby="servingTitle">
      <h2 id="servingTitle">{h.t.servingTitle}</h2>
      {rows.length === 0 ? (
        <p className="emptyServing">{h.t.emptyServing}</p>
      ) : (
        <div className="servingCards" role="list">
          {rows.map((row) => (
            <article className="servingCard" role="listitem" key={row.entry.id}>
              <span className={`queueState queueState-${row.entry.state}`}>
                {h.t.queueStatuses[row.entry.state]}
              </span>
              <strong className="ticket">{row.entry.publicDisplayLabel}</strong>
              <strong>{row.entry.privateDisplayName}</strong>
              <small>{entryMeta(row.entry, h)}</small>
              {row.entry.state === 'in_consultation' &&
                row.entry.activeConsultationRemainingMinutes !== null && (
                  <small>
                    {h.t.remainingConsult.replace(
                      '{n}',
                      String(row.entry.activeConsultationRemainingMinutes),
                    )}
                  </small>
                )}
              <div className="queueActions">
                <PrimaryButton row={row} h={h} emphasised />
                <ReasonPanel row={row} h={h} />
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function QueueRows({
  rows,
  arrived,
  notArrived,
  h,
}: {
  rows: ConsoleRow[];
  arrived: number;
  notArrived: number;
  h: RegionHandlers;
}) {
  const firstCheckedIn = rows.find((r) => r.entry.state === 'checked_in');
  return (
    <section className="queueRegion" aria-labelledby="queueRegionTitle">
      <h2 id="queueRegionTitle">{h.t.queueListTitle}</h2>
      <p className="queueCount">
        {h.t.queueCount
          .replace('{a}', String(arrived))
          .replace('{w}', String(notArrived))}
      </p>
      <div className="queueRows" role="list">
        {rows.map((row) => {
          const { entry } = row;
          const checkedIn = entry.state === 'checked_in';
          return (
            <article
              className="queueRow consoleRow"
              role="listitem"
              key={entry.id}
            >
              <span className="rowPosition">{row.position}</span>
              <strong className="ticket">{entry.publicDisplayLabel}</strong>
              <div>
                <strong>{entry.privateDisplayName}</strong>
                {row.isNext && (
                  <span className="chip nextChip">{h.t.nextChip}</span>
                )}
                {row.isPriority && (
                  <span className="chip priorityChip">{h.t.priorityBadge}</span>
                )}
                <small>{entryMeta(entry, h)}</small>
              </div>
              <div className="waitCell">
                {checkedIn && (
                  <>
                    <small>{h.t.waitEstimate}</small>
                    <strong>{formatWaitRange(entry.eta, h.t)}</strong>
                  </>
                )}
              </div>
              <span className={`queueState queueState-${entry.state}`}>
                {checkedIn ? h.t.queueStatuses.checked_in : h.t.notArrived}
              </span>
              <div className="queueActions">
                <PrimaryButton
                  row={row}
                  h={h}
                  emphasised={firstCheckedIn?.entry.id === entry.id}
                />
                <ReasonPanel row={row} h={h} />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
