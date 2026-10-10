import type { Pool, PoolClient } from 'pg';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import type { QueueEntryState } from '@/modules/queue';
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
import type { SessionStatus } from '@/modules/session';
import { inTransaction } from '@/platform/database/transaction';

const TERMINAL_STATE_RANK = 3;

// One dashboard-local state contract drives both ordering and ETA eligibility.
// QueueService.listOperational() intentionally retains its pre-WU9 SQL ordering;
// WU9 must not introduce a third independent active-state enumeration.
const OPERATIONAL_STATE_RANK: Readonly<Record<QueueEntryState, number>> = {
  in_consultation: 0,
  called: 0,
  checked_in: 1,
  waiting: 2,
  completed: TERMINAL_STATE_RANK,
  cancelled: TERMINAL_STATE_RANK,
  no_show: TERMINAL_STATE_RANK,
};
const OPERATIONAL_STATE_ORDER_SQL = Object.entries(OPERATIONAL_STATE_RANK)
  .map(([state, rank]) => `WHEN '${state}' THEN ${rank}`)
  .join(' ');

export interface ReceptionistDashboardEntry {
  id: string;
  sessionId: string;
  state: QueueEntryState;
  registrationOrder: number;
  eligibilityOrder: number | null;
  priorityOrder: number | null;
  publicDisplayLabel: string;
  privateDisplayName: string;
  preferredLocale: 'ar' | 'fr';
  hasContact: boolean;
  activeConsultationRemainingMinutes: number | null;
  eta: {
    patientsAhead: number;
    minWaitMinutes: number;
    maxWaitMinutes: number;
    revision: string;
    estimatedConsultationMinutes: number;
    estimateSource: QueueEtaEstimateSource;
    observedSampleCount: number;
    uncertainty?: EtaUncertaintySnapshot;
  } | null;
}

export interface ReceptionistDashboardSnapshot {
  generatedAt: string;
  refreshAfterSeconds: number;
  session: {
    id: string;
    doctorDisplayName: string;
    startsAt: string;
    endsAt: string;
    status: SessionStatus;
    declaredDelayMinutes: number | null;
    delayVersion: number;
    delayUpdatedAt: string | null;
    queueOrderVersion: number;
  };
  entries: ReceptionistDashboardEntry[];
}

type Row = {
  session_id: string;
  doctor_id: string;
  doctor_display_name: string;
  starts_at: Date;
  ends_at: Date;
  session_status: SessionStatus;
  declared_delay_minutes: number | null;
  delay_version: number;
  delay_updated_at: Date | null;
  queue_order_version: string;
  entry_id: string | null;
  entry_state: QueueEntryState | null;
  registration_order: string | null;
  eligibility_order: string | null;
  priority_order: string | null;
  public_display_label: string | null;
  private_display_name: string | null;
  preferred_locale: 'ar' | 'fr' | null;
  has_contact: boolean | null;
  in_consultation_started_at: Date | null;
};

/** Private receptionist projection. Never reuse this query for public displays. */
export class ReceptionistDashboardService {
  constructor(
    private readonly pool: Pool,
    private readonly now?: () => Date,
  ) {}

  async getSnapshot(
    scope: ClinicScope,
    sessionId: string,
    existingClient?: PoolClient,
  ): Promise<ReceptionistDashboardSnapshot> {
    // An internally supplied transaction is required to have established its
    // own REPEATABLE READ isolation BEFORE the first statement. This lets the
    // claim publisher read both provenance epochs and ETA inputs atomically.
    const build = async (client: PoolClient) => {
      // Existing public/staff display remains READ ONLY REPEATABLE READ.
      if (!existingClient) {
        await client.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
      }
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const result = await client.query<Row>(
        `SELECT session.id AS session_id,
                session.doctor_id,
                doctor.display_name AS doctor_display_name,
                session.starts_at, session.ends_at,
                session.status AS session_status,
                session.declared_delay_minutes, session.delay_version,
                session.delay_updated_at, session.queue_order_version,
                entry.id AS entry_id, entry.state AS entry_state,
                entry.registration_order, entry.eligibility_order,
                entry.priority_order, entry.public_display_label,
                entry.in_consultation_started_at,
                patient.private_display_name, patient.preferred_locale,
                (patient.contact_phone IS NOT NULL OR patient.contact_email IS NOT NULL) AS has_contact
           FROM consultation_sessions session
           JOIN doctor_profiles doctor ON doctor.id = session.doctor_id
           LEFT JOIN queue_entries entry
             ON entry.session_id = session.id AND entry.clinic_id = session.clinic_id
           LEFT JOIN patient_operational_records patient
             ON patient.id = entry.patient_id AND patient.clinic_id = entry.clinic_id
          WHERE session.id = $1 AND session.clinic_id = $2
          ORDER BY CASE entry.state ${OPERATIONAL_STATE_ORDER_SQL} ELSE ${TERMINAL_STATE_RANK} END,
                   CASE WHEN entry.priority_order IS NULL THEN 1 ELSE 0 END,
                   entry.priority_order NULLS LAST,
                   entry.eligibility_order NULLS LAST,
                   entry.registration_order NULLS LAST,
                   entry.id NULLS LAST`,
        [sessionId, scope.clinicId],
      );
      const first = result.rows[0];
      if (!first) throw new ReceptionistDashboardNotFoundError();

      const durationResult = await client.query<{ duration_minutes: string }>(
        `SELECT EXTRACT(EPOCH FROM (completed_at - in_consultation_started_at)) / 60 AS duration_minutes
           FROM queue_entries
          WHERE clinic_id = $1 AND session_id = $2
            AND completed_at IS NOT NULL
            AND in_consultation_started_at IS NOT NULL`,
        [scope.clinicId, sessionId],
      );
      const historicalDurationResult = await client.query<{
        duration_minutes: string;
      }>(
        `SELECT historical.duration_minutes
           FROM (
             SELECT EXTRACT(EPOCH FROM (entry.completed_at - entry.in_consultation_started_at)) / 60 AS duration_minutes,
                    entry.completed_at,
                    entry.id
               FROM queue_entries entry
               JOIN consultation_sessions historical_session
                 ON historical_session.id = entry.session_id
                AND historical_session.clinic_id = entry.clinic_id
              WHERE entry.clinic_id = $1
                AND historical_session.doctor_id = $3
                AND historical_session.id <> $2
                AND entry.completed_at IS NOT NULL
                AND entry.in_consultation_started_at IS NOT NULL
                AND entry.completed_at < $4
              ORDER BY entry.completed_at DESC, entry.id DESC
              LIMIT ${MAX_HISTORICAL_SAMPLES}
           ) historical`,
        [scope.clinicId, sessionId, first.doctor_id, first.starts_at],
      );
      // Priority decisions are durable audit facts; a current priority_order
      // alone cannot identify an earlier mutation after a patient was called.
      // Read them under the same REPEATABLE READ snapshot as queue positions.
      const priorityResult = await client.query<{ entry_id: string }>(
        `SELECT DISTINCT affected->>'entryId' AS entry_id
           FROM audit_events audit
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(audit.metadata->'resultingOrder')='array'
               THEN audit.metadata->'resultingOrder' ELSE '[]'::jsonb END
           ) affected
          WHERE audit.clinic_id=$1 AND audit.action='queue_entry.reordered'
            AND audit.metadata->>'sessionId'=$2`,
        [scope.clinicId, sessionId],
      );
      const priorityAffectedEntries = new Set(
        priorityResult.rows.map((row) => row.entry_id),
      );
      const estimate = selectConsultationEstimate(
        durationResult.rows.map((row) => row.duration_minutes),
        historicalDurationResult.rows.map((row) => row.duration_minutes),
      );
      const declaredDelayMinutes = first.declared_delay_minutes ?? 0;
      // Sample the production ETA instant inside the same committed read
      // transaction, never from this application's ambient wall clock.
      // A supplied clock is only for deterministic fixtures and the claim
      // publisher's trusted PostgreSQL time captured in its transaction.
      const clockResult = this.now
        ? null
        : await client.query<{ evaluated_at: Date }>(
            'SELECT clock_timestamp() AS evaluated_at',
          );
      const snapshotNow =
        this.now?.() ?? clockResult?.rows[0]?.evaluated_at;
      if (
        !(snapshotNow instanceof Date) ||
        !Number.isFinite(snapshotNow.getTime())
      ) {
        throw new Error('Trusted ETA evaluation instant is unavailable');
      }
      let patientsAhead = 0;
      // Retain the existing dashboard order and legacy range semantics.
      // v1 alone ranks the active consultation strictly ahead of called work,
      // keeping existing order stable within each state group.
      const v1ServiceRows = result.rows
        .filter(
          (row) =>
            row.entry_id &&
            (row.entry_state === 'in_consultation' ||
              row.entry_state === 'called' ||
              row.entry_state === 'checked_in'),
        )
        .sort((left, right) => {
          const rank = (state: QueueEntryState | null) =>
            state === 'in_consultation' ? 0 : state === 'called' ? 1 : 2;
          return rank(left.entry_state) - rank(right.entry_state);
        });
      const v1Positions = new Map(
        v1ServiceRows.map((row, index) => [row.entry_id, index]),
      );

      const entries = result.rows.flatMap((row) => {
        if (!row.entry_id) return [];
        const state = row.entry_state!;
        const eligible = OPERATIONAL_STATE_RANK[state] < TERMINAL_STATE_RANK;
        // A paused session is not advancing. Keep its committed state and
        // queue entries visible, but never display a precise-looking ETA.
        const etaEligible = eligible && first.session_status === 'open';
        const range = etaEligible
          ? createEtaSnapshot({
              patientsAhead,
              declaredDelayMinutes,
              estimatedConsultationMinutes:
                estimate.estimatedConsultationMinutes,
              estimateSource: estimate.estimateSource,
              observedSampleCount: estimate.observedSampleCount,
              queueOrderVersion: Number(first.queue_order_version),
              delayVersion: first.delay_version,
            })
          : null;
        // Count only committed v1 service slots preceding this target.
        // An active consultation precedes newly called work regardless of
        // historical eligibility/priority ordering.
        const v1Index = v1Positions.get(row.entry_id);
        const committedServiceAhead =
          v1Index === undefined ? [] : v1ServiceRows.slice(0, v1Index);
        const activeAhead = committedServiceAhead.filter(
          (prior) => prior.entry_state === 'in_consultation',
        );
        const activeStartedAt = activeAhead[0]?.in_consultation_started_at;
        let uncertainty: EtaUncertaintySnapshot | null = null;
        if (
          eligible &&
          state !== 'waiting' &&
          first.session_status === 'open' &&
          row.entry_id &&
          activeAhead.length <= 1 &&
          (activeAhead.length === 0 ||
            (activeStartedAt instanceof Date &&
              Number.isFinite(activeStartedAt.getTime()) &&
              activeStartedAt <= snapshotNow))
        ) {
          const queueRevision = Number(first.queue_order_version);
          try {
            const candidate = computeEtaUncertaintyV1({
              clinicId: scope.clinicId,
              sessionId,
              targetEntryId: row.entry_id,
              queueRevision,
              evaluatedAt: snapshotNow.toISOString(),
              declaredDelayMinutes,
              activeConsultationRemainingMinutes:
                activeStartedAt instanceof Date
                  ? computeActiveConsultationRemainingMinutes({
                      startedAt: activeStartedAt,
                      now: snapshotNow,
                      estimatedConsultationMinutes:
                        estimate.estimatedConsultationMinutes,
                    })
                  : 0,
              slotsAhead: committedServiceAhead.length,
              activeSlotIncludedInAhead: activeAhead.length === 1,
              calledNotStartedAhead: committedServiceAhead.filter(
                (prior) => prior.entry_state === 'called',
              ).length,
              priorityChanged:
                priorityAffectedEntries.has(row.entry_id) ||
                committedServiceAhead.some(
                  (prior) =>
                    prior.entry_id !== null &&
                    priorityAffectedEntries.has(prior.entry_id),
                ),
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
            // Invalid committed metadata cannot produce a v1 snapshot estimate.
          }
        }
        const eta =
          eligible && range
            ? {
                patientsAhead,
                minWaitMinutes: range.minWaitMinutes,
                maxWaitMinutes: range.maxWaitMinutes,
                revision: range.revision,
                estimatedConsultationMinutes:
                  estimate.estimatedConsultationMinutes,
                estimateSource: estimate.estimateSource,
                observedSampleCount: estimate.observedSampleCount,
                ...(uncertainty ? { uncertainty } : {}),
              }
            : null;
        if (eligible) patientsAhead += 1;
        return [
          {
            id: row.entry_id,
            sessionId: row.session_id,
            state,
            registrationOrder: Number(row.registration_order),
            eligibilityOrder:
              row.eligibility_order === null
                ? null
                : Number(row.eligibility_order),
            priorityOrder:
              row.priority_order === null ? null : Number(row.priority_order),
            publicDisplayLabel: row.public_display_label!,
            privateDisplayName: row.private_display_name!,
            preferredLocale: row.preferred_locale!,
            hasContact: row.has_contact!,
            activeConsultationRemainingMinutes:
              first.session_status === 'open' &&
              state === 'in_consultation' &&
              row.in_consultation_started_at
                ? computeActiveConsultationRemainingMinutes({
                    startedAt: row.in_consultation_started_at,
                    now: snapshotNow,
                    estimatedConsultationMinutes:
                      estimate.estimatedConsultationMinutes,
                  })
                : null,
            eta,
          },
        ];
      });

      return {
        generatedAt: snapshotNow.toISOString(),
        refreshAfterSeconds: 30,
        session: {
          id: first.session_id,
          doctorDisplayName: first.doctor_display_name,
          startsAt: first.starts_at.toISOString(),
          endsAt: first.ends_at.toISOString(),
          status: first.session_status,
          declaredDelayMinutes: first.declared_delay_minutes,
          delayVersion: first.delay_version,
          delayUpdatedAt: first.delay_updated_at?.toISOString() ?? null,
          queueOrderVersion: Number(first.queue_order_version),
        },
        entries,
      };
    };
    return existingClient
      ? build(existingClient)
      : inTransaction(this.pool, build);
  }
}

export class ReceptionistDashboardNotFoundError extends Error {
  constructor() {
    super('Consultation session was not found in this clinic');
    this.name = 'ReceptionistDashboardNotFoundError';
  }
}
