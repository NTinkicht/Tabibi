import type { Pool } from 'pg';
import {
  authenticatedGuestCredentialId,
  verifierMatches,
} from '@/modules/guest-access';
import {
  MAX_HISTORICAL_SAMPLES,
  computeActiveConsultationRemainingMinutes,
  type QueueEtaEstimateSource,
  selectConsultationEstimate,
} from '@/modules/queue-eta-estimator';
import { createEtaSnapshot } from '@/modules/queue-eta-estimator/snapshot';
import {
  computeEtaUncertaintyV1,
  isEtaUncertaintySnapshotForRevision,
  type EtaUncertaintySnapshot,
} from '@/modules/queue-eta-estimator/uncertainty-v1';
import { abortableQuery } from '@/platform/database/abortable-query';

const LIVE_QUEUE_STATES = new Set(['checked_in', 'called', 'in_consultation']);
const TERMINAL_BOOKING_STATES = new Set(['completed', 'cancelled', 'no_show']);
const TERMINAL_GRACE_MS = 15 * 60 * 1000;

export interface PublicGuestLiveQueueEta {
  patientsAhead: number;
  minWaitMinutes: number;
  maxWaitMinutes: number;
  revision: string;
  estimateSource: QueueEtaEstimateSource;
  delayStatus: 'declared' | null;
  uncertainty?: EtaUncertaintySnapshot;
}

export interface PublicGuestLiveQueueStatusResult {
  bookingState: string;
  queueState: string;
  pauseStatus: 'paused' | null;
  closureStatus: 'closed' | null;
  activeConsultationRemainingMinutes: number | null;
  eta: PublicGuestLiveQueueEta | null;
}

export class PublicGuestLiveQueueStatusRejectedError extends Error {
  constructor() {
    super('Guest live queue status request rejected');
    this.name = 'PublicGuestLiveQueueStatusRejectedError';
  }
}

type StatusRow = {
  bearer_verifier: string;
  expires_at: Date;
  revoked_at: Date | null;
  appointment_status: string;
  queue_state: string;
  session_status: string;
  session_closed_at: Date | null;
  in_consultation_started_at: Date | null;
  service_position: string | null;
  target_entry_id: string;
  clinic_id: string;
  session_id: string;
  committed_slots_ahead: string;
  called_slots_ahead: string;
  active_slots_ahead: string;
  active_ahead_started_at: Date | null;
  priority_changed: boolean;
  declared_delay_minutes: number | null;
  queue_order_version: string;
  delay_version: number;
  duration_samples: Array<number | string> | null;
  historical_duration_samples: Array<number | string> | null;
};

function bearerSecret(bearer: string): string | null {
  const parts = bearer.split('.');
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/** Read-only capability-bound guest queue snapshot. */
export class PublicGuestLiveQueueStatusService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(
    bearer: string,
    signal?: AbortSignal,
  ): Promise<PublicGuestLiveQueueStatusResult> {
    const credentialId = authenticatedGuestCredentialId(bearer);
    const secret = bearerSecret(bearer);
    if (!credentialId || !secret)
      throw new PublicGuestLiveQueueStatusRejectedError();

    const result = await abortableQuery<StatusRow>(
      this.pool,
      `WITH target AS (
         SELECT credential.id AS credential_id,
                credential.clinic_id,
                credential.session_id,
                credential.queue_entry_id,
                target_session.doctor_id,
                target_session.starts_at
           FROM guest_credentials credential
           JOIN consultation_sessions target_session
             ON target_session.id = credential.session_id
            AND target_session.clinic_id = credential.clinic_id
          WHERE credential.id = $1
       ),
       ordered AS (
         SELECT entry.id,
                entry.state,
                entry.in_consultation_started_at,
                row_number() OVER (
                  ORDER BY
                    CASE entry.state
                      WHEN 'in_consultation' THEN 0
                      WHEN 'called' THEN 0
                      WHEN 'checked_in' THEN 1
                      WHEN 'waiting' THEN 2
                      ELSE 3
                    END,
                    CASE WHEN entry.priority_order IS NULL THEN 1 ELSE 0 END,
                    entry.priority_order NULLS LAST,
                    entry.eligibility_order NULLS LAST,
                    entry.registration_order,
                    entry.id
                ) AS service_position,
                row_number() OVER (
                  ORDER BY
                    CASE entry.state
                      WHEN 'in_consultation' THEN 0
                      WHEN 'called' THEN 1
                      WHEN 'checked_in' THEN 2
                      WHEN 'waiting' THEN 3
                      ELSE 4
                    END,
                    CASE WHEN entry.priority_order IS NULL THEN 1 ELSE 0 END,
                    entry.priority_order NULLS LAST,
                    entry.eligibility_order NULLS LAST,
                    entry.registration_order,
                    entry.id
                ) AS v1_service_position
           FROM queue_entries entry, target
          WHERE entry.clinic_id = target.clinic_id
            AND entry.session_id = target.session_id
            AND entry.state IN ('waiting', 'checked_in', 'called', 'in_consultation')
       ),
       durations AS (
         SELECT EXTRACT(EPOCH FROM (duration_entry.completed_at - duration_entry.in_consultation_started_at)) / 60 AS duration_minutes
           FROM queue_entries duration_entry, target
          WHERE duration_entry.clinic_id = target.clinic_id
            AND duration_entry.session_id = target.session_id
            AND duration_entry.completed_at IS NOT NULL
            AND duration_entry.in_consultation_started_at IS NOT NULL
       ),
       historical_durations AS (
         SELECT historical.duration_minutes
           FROM (
             SELECT EXTRACT(EPOCH FROM (history_entry.completed_at - history_entry.in_consultation_started_at)) / 60 AS duration_minutes,
                    history_entry.completed_at,
                    history_entry.id
               FROM queue_entries history_entry
               JOIN consultation_sessions history_session
                 ON history_session.id = history_entry.session_id
                AND history_session.clinic_id = history_entry.clinic_id
               CROSS JOIN target
              WHERE history_entry.clinic_id = target.clinic_id
                AND history_session.doctor_id = target.doctor_id
                AND history_session.id <> target.session_id
                AND history_entry.completed_at IS NOT NULL
                AND history_entry.in_consultation_started_at IS NOT NULL
                AND history_entry.completed_at < target.starts_at
              ORDER BY history_entry.completed_at DESC, history_entry.id DESC
              LIMIT ${MAX_HISTORICAL_SAMPLES}
           ) historical
       )
       SELECT credential.bearer_verifier,
              credential.expires_at,
              credential.revoked_at,
              appointment.status::text AS appointment_status,
              entry.state::text AS queue_state,
              session.status::text AS session_status,
              session.closed_at AS session_closed_at,
              entry.in_consultation_started_at,
              ordered.service_position::text AS service_position,
              entry.id AS target_entry_id,
              entry.clinic_id,
              entry.session_id,
              (SELECT count(*) FROM ordered preceding
                WHERE preceding.v1_service_position < ordered.v1_service_position
                  AND preceding.state IN ('checked_in','called','in_consultation'))::text
                AS committed_slots_ahead,
              (SELECT count(*) FROM ordered preceding
                WHERE preceding.v1_service_position < ordered.v1_service_position
                  AND preceding.state = 'called')::text AS called_slots_ahead,
              (SELECT count(*) FROM ordered preceding
                WHERE preceding.v1_service_position < ordered.v1_service_position
                  AND preceding.state = 'in_consultation')::text AS active_slots_ahead,
              (SELECT preceding.in_consultation_started_at
                 FROM ordered preceding
                WHERE preceding.v1_service_position < ordered.v1_service_position
                  AND preceding.state = 'in_consultation'
                ORDER BY preceding.service_position LIMIT 1) AS active_ahead_started_at,
              EXISTS (
                SELECT 1 FROM audit_events priority_audit
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(priority_audit.metadata->'resultingOrder')='array'
                    THEN priority_audit.metadata->'resultingOrder'
                    ELSE '[]'::jsonb
                  END
                ) priority_item
                JOIN ordered priority_slot
                  ON priority_slot.id::text = priority_item->>'entryId'
                WHERE priority_audit.clinic_id=entry.clinic_id
                  AND priority_audit.action='queue_entry.reordered'
                  AND priority_audit.metadata->>'sessionId'=entry.session_id::text
                  AND priority_slot.v1_service_position <= ordered.v1_service_position
                  AND priority_slot.state IN ('checked_in','called','in_consultation')
              ) AS priority_changed,
              session.declared_delay_minutes,
              session.queue_order_version,
              session.delay_version,
              (SELECT array_agg(duration_minutes) FROM durations) AS duration_samples,
              (SELECT array_agg(duration_minutes) FROM historical_durations) AS historical_duration_samples
         FROM guest_credentials credential
         JOIN public_guest_booking_receipts receipt
           ON receipt.credential_id = credential.id
          AND receipt.clinic_id = credential.clinic_id
          AND receipt.queue_entry_id = credential.queue_entry_id
          AND receipt.completed_at IS NOT NULL
         JOIN queue_entries entry
           ON entry.id = credential.queue_entry_id
          AND entry.clinic_id = credential.clinic_id
          AND entry.session_id = credential.session_id
         JOIN appointments appointment
           ON appointment.id = receipt.appointment_id
          AND appointment.queue_entry_id = receipt.queue_entry_id
          AND appointment.queue_entry_id = entry.id
          AND appointment.clinic_id = entry.clinic_id
          AND appointment.session_id = entry.session_id
          AND appointment.patient_id = entry.patient_id
          AND appointment.patient_id = receipt.patient_id
         JOIN consultation_sessions session
           ON session.id = entry.session_id
          AND session.clinic_id = entry.clinic_id
         LEFT JOIN ordered ON ordered.id = entry.id
        WHERE credential.id = $1`,
      [credentialId],
      signal,
    );

    const row = result.rows[0];
    const snapshotNow = this.clock();
    if (
      !row ||
      !verifierMatches(row.bearer_verifier, secret) ||
      row.revoked_at ||
      row.expires_at <= snapshotNow
    )
      throw new PublicGuestLiveQueueStatusRejectedError();

    const estimate = selectConsultationEstimate(
      row.duration_samples ?? [],
      row.historical_duration_samples ?? [],
    );
    const isTerminal = TERMINAL_BOOKING_STATES.has(row.appointment_status);
    // Legal session closure requires terminal queue entries. Show the
    // closure notice only during its bounded grace window, then preserve
    // the existing terminal booking summary for the credential's normal TTL.
    const sessionClosed = row.session_status === 'closed';
    const closureGraceExpired =
      sessionClosed &&
      (!row.session_closed_at ||
        snapshotNow.getTime() - row.session_closed_at.getTime() >
          TERMINAL_GRACE_MS);
    if (closureGraceExpired && !isTerminal) {
      throw new PublicGuestLiveQueueStatusRejectedError();
    }
    const isClosed = sessionClosed && !closureGraceExpired;
    const isPaused = !isTerminal && row.session_status === 'paused';
    const activeConsultationRemainingMinutes =
      !isTerminal &&
      !isPaused &&
      !isClosed &&
      row.queue_state === 'in_consultation' &&
      row.in_consultation_started_at
        ? computeActiveConsultationRemainingMinutes({
            startedAt: row.in_consultation_started_at,
            now: snapshotNow,
            estimatedConsultationMinutes: estimate.estimatedConsultationMinutes,
          })
        : null;

    return {
      bookingState: row.appointment_status,
      queueState: row.queue_state,
      pauseStatus: isPaused ? 'paused' : null,
      closureStatus: isClosed ? 'closed' : null,
      activeConsultationRemainingMinutes,
      eta: this.computeEta(row, estimate, snapshotNow),
    };
  }

  private computeEta(
    row: StatusRow,
    estimate: ReturnType<typeof selectConsultationEstimate>,
    snapshotNow: Date,
  ): PublicGuestLiveQueueEta | null {
    if (
      TERMINAL_BOOKING_STATES.has(row.appointment_status) ||
      row.session_status === 'paused' ||
      row.session_status === 'closed' ||
      !LIVE_QUEUE_STATES.has(row.queue_state) ||
      !row.service_position
    )
      return null;

    const declaredDelayMinutes = row.declared_delay_minutes ?? 0;
    const patientsAhead = Math.max(0, Number(row.service_position) - 1);
    const range = createEtaSnapshot({
      patientsAhead,
      declaredDelayMinutes,
      estimatedConsultationMinutes: estimate.estimatedConsultationMinutes,
      estimateSource: estimate.estimateSource,
      observedSampleCount: estimate.observedSampleCount,
      queueOrderVersion: Number(row.queue_order_version),
      delayVersion: row.delay_version,
    });

    // The guest v1 candidate is derived solely from one scoped SQL snapshot.
    // An active slot without a valid committed start cannot produce v1 evidence.
    let uncertainty: EtaUncertaintySnapshot | null = null;
    const activeAhead = Number(row.active_slots_ahead);
    const start = row.active_ahead_started_at;
    const validActiveSlot =
      activeAhead === 0 ||
      (activeAhead === 1 &&
        start instanceof Date &&
        Number.isFinite(start.getTime()) &&
        start <= snapshotNow);

    // Keep the atomic-snapshot computation block together as a single review unit.
    // prettier-ignore
    if (row.session_status === 'open' && validActiveSlot) {
      const queueRevision = Number(row.queue_order_version);
      try {
        const activeRemaining =
          activeAhead === 1 && start
            ? computeActiveConsultationRemainingMinutes({
                startedAt: start,
                now: snapshotNow,
                estimatedConsultationMinutes:
                  estimate.estimatedConsultationMinutes,
              })
            : 0;
        const candidate = computeEtaUncertaintyV1({
          clinicId: row.clinic_id,
          sessionId: row.session_id,
          targetEntryId: row.target_entry_id,
          queueRevision,
          evaluatedAt: snapshotNow.toISOString(),
          declaredDelayMinutes,
          activeConsultationRemainingMinutes: activeRemaining,
          slotsAhead: Number(row.committed_slots_ahead),
          calledNotStartedAhead: Number(row.called_slots_ahead),
          activeSlotIncludedInAhead: activeAhead === 1,
          priorityChanged: row.priority_changed,
          estimatedConsultationMinutes:
            estimate.estimatedConsultationMinutes,
          estimateSource: estimate.estimateSource,
          sessionStatus: 'open',
        });
        if (isEtaUncertaintySnapshotForRevision(candidate, queueRevision)) {
          uncertainty = candidate;
        }
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }

    return {
      patientsAhead,
      minWaitMinutes: range.minWaitMinutes,
      maxWaitMinutes: range.maxWaitMinutes,
      revision: range.revision,
      estimateSource: estimate.estimateSource,
      delayStatus: range.delayStatus,
      ...(uncertainty ? { uncertainty } : {}),
    };
  }
}
