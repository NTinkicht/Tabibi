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
  /** Sessions that were actually opened (opened_at set). */
  openedSessions: number;
  /** Opened sessions whose opened_at is after the scheduled starts_at. */
  lateStarts: number;
  /** Mean start delay in minutes (early opens count as 0); null below MIN_COHORT_FOR_AVERAGE opened sessions. */
  averageStartDelayMinutes: number | null;
}

export interface DelayTrendDay {
  date: string;
  sessions: number;
  opened: number;
  lateStarts: number;
}

export interface ClinicOperationalStatistics {
  from: string;
  to: string;
  doctors: DoctorOperationalStatistics[];
  /** Counts only, one row per service date that has sessions. */
  delayTrend: DelayTrendDay[];
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
  opened: string;
  late: string;
  avg_delay_minutes: string | null;
}

interface TrendRow {
  day: string;
  sessions: string;
  opened: string;
  late: string;
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
                  AND qe.completed_at IS NOT NULL) AS avg_seconds,
              (SELECT count(*) FROM consultation_sessions s2
                WHERE s2.clinic_id = $1 AND s2.doctor_id = cs.doctor_id
                  AND s2.service_date BETWEEN $2::date AND $3::date
                  AND s2.opened_at IS NOT NULL) AS opened,
              (SELECT count(*) FROM consultation_sessions s2
                WHERE s2.clinic_id = $1 AND s2.doctor_id = cs.doctor_id
                  AND s2.service_date BETWEEN $2::date AND $3::date
                  AND s2.opened_at > s2.starts_at) AS late,
              (SELECT avg(GREATEST(0, EXTRACT(EPOCH FROM s2.opened_at - s2.starts_at) / 60))
                 FROM consultation_sessions s2
                WHERE s2.clinic_id = $1 AND s2.doctor_id = cs.doctor_id
                  AND s2.service_date BETWEEN $2::date AND $3::date
                  AND s2.opened_at IS NOT NULL) AS avg_delay_minutes
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
    const trend = await this.pool.query<TrendRow>(
      `SELECT to_char(service_date, 'YYYY-MM-DD') AS day,
              count(*) AS sessions,
              count(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
              count(*) FILTER (WHERE opened_at > starts_at) AS late
         FROM consultation_sessions
        WHERE clinic_id = $1
          AND service_date BETWEEN $2::date AND $3::date
        GROUP BY service_date
        ORDER BY service_date`,
      [input.clinicId, input.from, input.to],
    );
    return {
      from: input.from,
      to: input.to,
      delayTrend: trend.rows.map((r) => ({
        date: r.day,
        sessions: Number(r.sessions),
        opened: Number(r.opened),
        lateStarts: Number(r.late),
      })),
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
        openedSessions: Number(r.opened),
        lateStarts: Number(r.late),
        averageStartDelayMinutes:
          Number(r.opened) >= MIN_COHORT_FOR_AVERAGE &&
          r.avg_delay_minutes !== null
            ? Math.round(Number(r.avg_delay_minutes))
            : null,
      })),
    };
  }
}
