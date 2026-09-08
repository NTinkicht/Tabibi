import type { Pool } from 'pg';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import type { QueueEntryState } from '@/modules/queue';
import type { SessionStatus } from '@/modules/session';
import { inTransaction } from '@/platform/database/transaction';

const FALLBACK_CONSULTATION_MINUTES = 15;
const MIN_OBSERVED_SAMPLES = 3;
const MIN_SAMPLE_MINUTES = 2;
const MAX_SAMPLE_MINUTES = 120;
const ETA_MIN_MULTIPLIER = 0.75;
const ETA_MAX_MULTIPLIER = 1.5;
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
  eta: {
    patientsAhead: number;
    minWaitMinutes: number;
    maxWaitMinutes: number;
    estimatedConsultationMinutes: number;
    estimateSource: 'fallback' | 'observed_median';
    observedSampleCount: number;
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
};

function clampDuration(value: number): number {
  return Math.min(MAX_SAMPLE_MINUTES, Math.max(MIN_SAMPLE_MINUTES, value));
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle]!;
  return (ordered[middle - 1]! + ordered[middle]!) / 2;
}

/** Private receptionist projection. Never reuse this query for public displays. */
export class ReceptionistDashboardService {
  constructor(private readonly pool: Pool) {}

  async getSnapshot(
    scope: ClinicScope,
    sessionId: string,
  ): Promise<ReceptionistDashboardSnapshot> {
    return inTransaction(this.pool, async (client) => {
      // getSnapshot performs multiple SELECTs that must observe one committed state.
      // PostgreSQL READ COMMITTED takes a fresh snapshot per statement, which can mix
      // queue/session rows from one version with duration samples from a later commit.
      // This read-only REPEATABLE READ transaction fixes one snapshot for the whole read.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await requireClinicRole(client, scope, ['receptionist', 'clinic_admin']);
      const result = await client.query<Row>(
        `SELECT session.id AS session_id,
                doctor.display_name AS doctor_display_name,
                session.starts_at, session.ends_at,
                session.status AS session_status,
                session.declared_delay_minutes, session.delay_version,
                session.delay_updated_at, session.queue_order_version,
                entry.id AS entry_id, entry.state AS entry_state,
                entry.registration_order, entry.eligibility_order,
                entry.priority_order, entry.public_display_label,
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
      const samples = durationResult.rows
        .map((row) => Number(row.duration_minutes))
        .filter((value) => Number.isFinite(value))
        .map(clampDuration);
      const useObserved = samples.length >= MIN_OBSERVED_SAMPLES;
      const estimatedConsultationMinutes = useObserved
        ? median(samples)
        : FALLBACK_CONSULTATION_MINUTES;
      const declaredDelayMinutes = first.declared_delay_minutes ?? 0;
      let patientsAhead = 0;

      const entries = result.rows.flatMap((row) => {
        if (!row.entry_id) return [];
        const state = row.entry_state!;
        const eligible = OPERATIONAL_STATE_RANK[state] < TERMINAL_STATE_RANK;
        const eta = eligible
          ? {
              patientsAhead,
              minWaitMinutes: Math.round(
                declaredDelayMinutes +
                  patientsAhead *
                    estimatedConsultationMinutes *
                    ETA_MIN_MULTIPLIER,
              ),
              maxWaitMinutes: Math.round(
                declaredDelayMinutes +
                  patientsAhead *
                    estimatedConsultationMinutes *
                    ETA_MAX_MULTIPLIER,
              ),
              estimatedConsultationMinutes,
              estimateSource: useObserved
                ? ('observed_median' as const)
                : ('fallback' as const),
              observedSampleCount: samples.length,
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
            eta,
          },
        ];
      });

      return {
        generatedAt: new Date().toISOString(),
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
    });
  }
}

export class ReceptionistDashboardNotFoundError extends Error {
  constructor() {
    super('Consultation session was not found in this clinic');
    this.name = 'ReceptionistDashboardNotFoundError';
  }
}
