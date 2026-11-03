import type { Pool } from 'pg';
import type { EtaNotificationSnapshot } from './eta-notification-gate';

interface BaselineRow {
  queue_entry_id: string;
  revision: string;
  estimator_version: string;
  session_epoch: string;
  prior_epoch: string;
  min_wait_minutes: number;
  max_wait_minutes: number;
  queue_position: number;
}

export interface EtaNotificationBaselineStore {
  load(
    clinicId: string,
    queueEntryId: string,
  ): Promise<EtaNotificationSnapshot | null>;
  /** Insert the first baseline; false when one already exists. */
  recordInitial(
    clinicId: string,
    snapshot: EtaNotificationSnapshot,
  ): Promise<boolean>;
  /** Move the baseline forward; false when not strictly newer or not found. */
  advance(
    clinicId: string,
    snapshot: EtaNotificationSnapshot,
  ): Promise<boolean>;
}

/** Clinic-scoped PostgreSQL baseline store; every statement filters by clinic. */
export class PgEtaNotificationBaselineStore
  implements EtaNotificationBaselineStore
{
  constructor(private readonly pool: Pool) {}

  async load(clinicId: string, queueEntryId: string) {
    const r = await this.pool.query<BaselineRow>(
      `SELECT queue_entry_id, revision, estimator_version, session_epoch,
              prior_epoch, min_wait_minutes, max_wait_minutes, queue_position
         FROM eta_notification_baselines
        WHERE clinic_id = $1 AND queue_entry_id = $2`,
      [clinicId, queueEntryId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      queueEntryId: row.queue_entry_id,
      revision: Number(row.revision),
      estimatorVersion: row.estimator_version,
      sessionEpoch: Number(row.session_epoch),
      priorEpoch: Number(row.prior_epoch),
      minWaitMinutes: row.min_wait_minutes,
      maxWaitMinutes: row.max_wait_minutes,
      queuePosition: row.queue_position,
    };
  }

  async recordInitial(clinicId: string, s: EtaNotificationSnapshot) {
    const r = await this.pool.query(
      `INSERT INTO eta_notification_baselines
         (queue_entry_id, clinic_id, revision, estimator_version, session_epoch,
          prior_epoch, min_wait_minutes, max_wait_minutes, queue_position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (queue_entry_id) DO NOTHING`,
      this.values(clinicId, s),
    );
    return r.rowCount === 1;
  }

  async advance(clinicId: string, s: EtaNotificationSnapshot) {
    const r = await this.pool.query(
      `UPDATE eta_notification_baselines
          SET revision=$3, estimator_version=$4, session_epoch=$5,
              prior_epoch=$6, min_wait_minutes=$7, max_wait_minutes=$8,
              queue_position=$9, updated_at=now()
        WHERE clinic_id=$2 AND queue_entry_id=$1 AND revision < $3`,
      this.values(clinicId, s),
    );
    return r.rowCount === 1;
  }

  private values(clinicId: string, s: EtaNotificationSnapshot) {
    return [
      s.queueEntryId.trim(),
      clinicId,
      s.revision,
      s.estimatorVersion,
      s.sessionEpoch,
      s.priorEpoch,
      s.minWaitMinutes,
      s.maxWaitMinutes,
      s.queuePosition,
    ];
  }
}
