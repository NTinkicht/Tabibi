import type { Pool } from 'pg';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import type { QueueEntryState } from '@/modules/queue';
import type { SessionStatus } from '@/modules/session';
import { inTransaction } from '@/platform/database/transaction';

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

/** Private receptionist projection. Never reuse this query for public displays. */
export class ReceptionistDashboardService {
  constructor(private readonly pool: Pool) {}

  async getSnapshot(
    scope: ClinicScope,
    sessionId: string,
  ): Promise<ReceptionistDashboardSnapshot> {
    return inTransaction(this.pool, async (client) => {
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
          ORDER BY CASE entry.state
                     WHEN 'in_consultation' THEN 0 WHEN 'called' THEN 0
                     WHEN 'checked_in' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
                   CASE WHEN entry.priority_order IS NULL THEN 1 ELSE 0 END,
                   entry.priority_order NULLS LAST,
                   entry.eligibility_order NULLS LAST,
                   entry.registration_order NULLS LAST,
                   entry.id NULLS LAST`,
        [sessionId, scope.clinicId],
      );
      const first = result.rows[0];
      if (!first) throw new ReceptionistDashboardNotFoundError();
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
        entries: result.rows.flatMap((row) =>
          row.entry_id
            ? [
                {
                  id: row.entry_id,
                  sessionId: row.session_id,
                  state: row.entry_state!,
                  registrationOrder: Number(row.registration_order),
                  eligibilityOrder:
                    row.eligibility_order === null
                      ? null
                      : Number(row.eligibility_order),
                  priorityOrder:
                    row.priority_order === null
                      ? null
                      : Number(row.priority_order),
                  publicDisplayLabel: row.public_display_label!,
                  privateDisplayName: row.private_display_name!,
                  preferredLocale: row.preferred_locale!,
                  hasContact: row.has_contact!,
                },
              ]
            : [],
        ),
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
