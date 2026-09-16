import type { Pool } from 'pg';
import {
  authenticatedGuestCredentialId,
  verifierMatches,
} from '@/modules/guest-access';
import {
  computeQueueEtaRange,
  MAX_HISTORICAL_SAMPLES,
  type QueueEtaEstimateSource,
  selectConsultationEstimate,
} from '@/modules/queue-eta-estimator';
import { abortableQuery } from '@/platform/database/abortable-query';

const LIVE_QUEUE_STATES = new Set(['checked_in', 'called', 'in_consultation']);
const TERMINAL_BOOKING_STATES = new Set(['completed', 'cancelled', 'no_show']);

export interface PublicGuestLiveQueueEta {
  patientsAhead: number;
  minWaitMinutes: number;
  maxWaitMinutes: number;
  estimateSource: QueueEtaEstimateSource;
}

export interface PublicGuestLiveQueueStatusResult {
  bookingState: string;
  queueState: string;
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
  service_position: string | null;
  declared_delay_minutes: number | null;
  duration_samples: Array<number | string> | null;
  historical_duration_samples: Array<number | string> | null;
};

function bearerSecret(bearer: string): string | null {
  const parts = bearer.split('.');
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/**
 * Read-only public live queue status authorized exclusively by the existing
 * guest capability and bound to the immutable completed booking receipt.
 * No caller-supplied internal identifier participates in authorization or
 * scope. This performs a single plain SELECT (no lock, no transaction, no
 * mutation, no audit event), so repeated and concurrent reads are inherently
 * side-effect free. The single-statement CTE query below computes lifecycle,
 * authoritative service order, declared delay, current-session durations, and
 * bounded same-clinic/same-doctor historical durations from one PostgreSQL
 * query snapshot, so ETA inputs cannot mix versions.
 */
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
                ) AS service_position
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
              ordered.service_position::text AS service_position,
              session.declared_delay_minutes,
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
         LEFT JOIN ordered
           ON ordered.id = entry.id
        WHERE credential.id = $1`,
      [credentialId],
      signal,
    );

    const row = result.rows[0];
    if (
      !row ||
      !verifierMatches(row.bearer_verifier, secret) ||
      row.revoked_at ||
      row.expires_at <= this.clock()
    )
      throw new PublicGuestLiveQueueStatusRejectedError();

    return {
      bookingState: row.appointment_status,
      queueState: row.queue_state,
      eta: this.computeEta(row),
    };
  }

  private computeEta(row: StatusRow): PublicGuestLiveQueueEta | null {
    if (
      TERMINAL_BOOKING_STATES.has(row.appointment_status) ||
      !LIVE_QUEUE_STATES.has(row.queue_state) ||
      !row.service_position
    )
      return null;

    const estimate = selectConsultationEstimate(
      row.duration_samples ?? [],
      row.historical_duration_samples ?? [],
    );
    const declaredDelayMinutes = row.declared_delay_minutes ?? 0;
    const patientsAhead = Math.max(0, Number(row.service_position) - 1);
    const range = computeQueueEtaRange({
      patientsAhead,
      declaredDelayMinutes,
      estimatedConsultationMinutes: estimate.estimatedConsultationMinutes,
    });

    return {
      patientsAhead,
      minWaitMinutes: range.minWaitMinutes,
      maxWaitMinutes: range.maxWaitMinutes,
      estimateSource: estimate.estimateSource,
    };
  }
}
