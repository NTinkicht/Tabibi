import type { Pool } from 'pg';

/** Averages are withheld below this many timed completions (small-cohort rule). */
export const MIN_COHORT_FOR_AVERAGE = 5;
export const MAX_WINDOW_DAYS = 31;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface DoctorOperationalStatistics {
  doctorId: string;
  doctorName: string;
  sessions: number;
  completed: number;
  noShow: number;
  cancelled: number;
  /** Null when fewer than MIN_COHORT_FOR_AVERAGE timed completions exist. */
  averageConsultationSeconds: number | null;
}

export interface ClinicOperationalStatistics {
  from: string;
  to: string;
  doctors: DoctorOperationalStatistics[];
}

export class StatisticsWindowError extends RangeError {}

function parseDay(value: string, label: string): number {
  if (!DAY.test(value))
    throw new StatisticsWindowError(`${label} must be YYYY-MM-DD`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value)
    throw new StatisticsWindowError(`${label} is not a real calendar date`);
  return ms;
}

export function validateStatisticsWindow(from: string, to: string): void {
  const start = parseDay(from, 'from');
  const end = parseDay(to, 'to');
  if (end < start) throw new StatisticsWindowError('to must not precede from');
  if ((end - start) / 86_400_000 + 1 > MAX_WINDOW_DAYS)
    throw new StatisticsWindowError(
      `window is limited to ${MAX_WINDOW_DAYS} days`,
    );
}

interface Row {
  doctor_id: string;
  display_name: string;
  sessions: string;
  completed: string;
  no_show: string;
  cancelled: string;
  timed: string;
  avg_seconds: string | null;
}

/**
 * Operational throughput per doctor over session service dates. Counts only:
 * no patient identity, contact or clinical inference. Tenant-scoped in SQL.
 */
export class ClinicStatisticsRepository {
  constructor(private readonly pool: Pool) {}

  async forWindow(input: {
    clinicId: string;
    from: string;
    to: string;
  }): Promise<ClinicOperationalStatistics> {
    validateStatisticsWindow(input.from, input.to);
    const { rows } = await this.pool.query<Row>(
      `SELECT cs.doctor_id,
              dp.display_name,
              count(DISTINCT cs.id) AS sessions,
              count(qe.id) FILTER (WHERE qe.state = 'completed') AS completed,
              count(qe.id) FILTER (WHERE qe.state = 'no_show') AS no_show,
              count(qe.id) FILTER (WHERE qe.state = 'cancelled') AS cancelled,
              count(qe.id) FILTER (WHERE qe.state = 'completed'
                AND qe.in_consultation_started_at IS NOT NULL
                AND qe.completed_at IS NOT NULL) AS timed,
              avg(EXTRACT(EPOCH FROM qe.completed_at - qe.in_consultation_started_at))
                FILTER (WHERE qe.state = 'completed'
                  AND qe.in_consultation_started_at IS NOT NULL
                  AND qe.completed_at IS NOT NULL) AS avg_seconds
         FROM consultation_sessions cs
         JOIN doctor_profiles dp ON dp.id = cs.doctor_id
         LEFT JOIN queue_entries qe
           ON qe.session_id = cs.id AND qe.clinic_id = cs.clinic_id
        WHERE cs.clinic_id = $1
          AND cs.service_date BETWEEN $2::date AND $3::date
        GROUP BY cs.doctor_id, dp.display_name
        ORDER BY dp.display_name, cs.doctor_id`,
      [input.clinicId, input.from, input.to],
    );
    return {
      from: input.from,
      to: input.to,
      doctors: rows.map((r) => ({
        doctorId: r.doctor_id,
        doctorName: r.display_name,
        sessions: Number(r.sessions),
        completed: Number(r.completed),
        noShow: Number(r.no_show),
        cancelled: Number(r.cancelled),
        averageConsultationSeconds:
          Number(r.timed) >= MIN_COHORT_FOR_AVERAGE && r.avg_seconds !== null
            ? Math.round(Number(r.avg_seconds))
            : null,
      })),
    };
  }
}
