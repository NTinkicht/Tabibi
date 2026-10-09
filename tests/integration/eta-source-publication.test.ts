import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueueService } from '@/modules/queue';
import {
  EtaPublicationConflictError,
  EtaPublicationStaleError,
  EtaUncertaintyClaimService,
  type EtaSourceTuple,
} from '@/modules/queue-eta-estimator/claim-publication';
import {
  computeEtaUncertaintyV1,
  type EtaUncertaintySnapshot,
} from '@/modules/queue-eta-estimator/uncertainty-v1';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  actor: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  historicSession: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.actor };
const evaluatedAt = '2026-09-08T10:05:30.000Z';
type EpochRow = { session_id: string; source_epoch: string };

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts,
    queue_command_receipts, queue_registration_receipts, queue_entries,
    patient_operational_records, session_command_receipts,
    consultation_sessions, schedule_templates, doctor_clinics,
    doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'eta-claim-actor','Receptionist'),
      ($2,'eta-claim-doctor','Doctor')`,
    [ids.actor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
      ($1,'eta-claim-clinic','Clinic'),
      ($2,'eta-claim-other','Other clinic')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
     VALUES ($1,$2,'receptionist')`,
    [ids.clinic, ids.actor],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name)
     VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id)
     VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES ($1,$2,$3,'2026-09-08',
       '2026-09-08 09:00Z','2026-09-08 12:00Z','open'),
       ($4,$2,$3,'2026-09-07',
       '2026-09-07 09:00Z','2026-09-07 12:00Z','planned')`,
    [ids.session, ids.clinic, ids.doctor, ids.historicSession],
  );
});
afterAll(async () => pool.end());

async function checkedIn(idempotencyKey: string): Promise<string> {
  const queue = new QueueService(pool);
  const registered = await queue.registerWalkIn(scope, ids.session, {
    privateDisplayName: idempotencyKey,
    preferredLocale: 'fr',
    idempotencyKey: `register-${idempotencyKey}`,
    correlationId: `register-${idempotencyKey}`,
  });
  await queue.command(scope, ids.session, registered.entry.id, {
    command: 'check_in',
    idempotencyKey: `check-in-${idempotencyKey}`,
    correlationId: `check-in-${idempotencyKey}`,
  });
  return registered.entry.id;
}

function estimate(
  targetEntryId: string,
  source: EtaSourceTuple,
  declaredDelayMinutes = 0,
): EtaUncertaintySnapshot {
  return computeEtaUncertaintyV1({
    clinicId: ids.clinic,
    sessionId: ids.session,
    targetEntryId,
    queueRevision: source.queueRevision,
    evaluatedAt,
    declaredDelayMinutes,
    activeConsultationRemainingMinutes: 0,
    slotsAhead: 0,
    estimatedConsultationMinutes: 15,
    estimateSource: 'fallback',
    sessionStatus: 'open',
  });
}

describe('WU610: atomic, immutable ETA claim publication', () => {
  it('accepts one exact-source claim and converges concurrent identical retries', async () => {
    const entryId = await checkedIn('eta-claim-first');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, entryId);
    const snapshot = estimate(entryId, source);
    const claims = await Promise.all([
      service.claim(scope, ids.session, entryId, source, snapshot),
      service.claim(scope, ids.session, entryId, source, snapshot),
    ]);
    expect(claims[0]).toEqual(claims[1]);
    const same = await service.claim(
      scope,
      ids.session,
      entryId,
      source,
      snapshot,
    );
    expect(same).toEqual(claims[0]);
    const rows = await pool.query(
      'SELECT id FROM eta_uncertainty_claims WHERE queue_entry_id=$1',
      [entryId],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('refuses stale claims after delay changes without changing queue order', async () => {
    const entryId = await checkedIn('eta-claim-delay');
    const service = new EtaUncertaintyClaimService(pool);
    const before = await service.readSourceTuple(scope, ids.session, entryId);
    const snapshot = estimate(entryId, before);
    await pool.query(
      `UPDATE consultation_sessions
          SET declared_delay_minutes=25,delay_version=delay_version+1,
              delay_updated_at=now()
        WHERE id=$1 AND clinic_id=$2`,
      [ids.session, ids.clinic],
    );
    const after = await service.readSourceTuple(scope, ids.session, entryId);
    expect(after.sourceEpoch).toBeGreaterThan(before.sourceEpoch);
    expect(after.queueRevision).toBe(before.queueRevision);
    await expect(
      service.claim(scope, ids.session, entryId, before, snapshot),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);
    const newer = await service.claim(
      scope,
      ids.session,
      entryId,
      after,
      estimate(entryId, after, 25),
    );
    expect(newer.snapshot.expectedMinutes).toBe(25);
  });

  it('invalidates a current session claim when another session changes the clinic prior', async () => {
    const entryId = await checkedIn('eta-claim-prior');
    const service = new EtaUncertaintyClaimService(pool);
    const before = await service.readSourceTuple(scope, ids.session, entryId);
    const historic = await new QueueService(pool).registerWalkIn(
      scope,
      ids.historicSession,
      {
        privateDisplayName: 'Historic consultation',
        preferredLocale: 'ar',
        idempotencyKey: 'eta-historic-reg',
        correlationId: 'eta-historic-reg',
      },
    );
    await pool.query(
      `UPDATE queue_entries
          SET state='completed',
              in_consultation_started_at='2026-09-07 09:00Z',
              completed_at='2026-09-07 09:12Z'
        WHERE id=$1`,
      [historic.entry.id],
    );
    const after = await service.readSourceTuple(scope, ids.session, entryId);
    expect(after.sourceEpoch).toBe(before.sourceEpoch);
    expect(after.clinicPriorEpoch).toBeGreaterThan(before.clinicPriorEpoch);
    await expect(
      service.claim(
        scope,
        ids.session,
        entryId,
        before,
        estimate(entryId, before),
      ),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);
  });

  it('rejects a stale claim after queue mutation and paused state', async () => {
    const entryId = await checkedIn('eta-claim-state');
    const queue = new QueueService(pool);
    const service = new EtaUncertaintyClaimService(pool);
    const before = await service.readSourceTuple(scope, ids.session, entryId);
    await queue.command(scope, ids.session, entryId, {
      command: 'call',
      idempotencyKey: 'eta-claim-call',
      correlationId: 'eta-claim-call',
    });
    await expect(
      service.claim(
        scope,
        ids.session,
        entryId,
        before,
        estimate(entryId, before),
      ),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);

    const called = await service.readSourceTuple(scope, ids.session, entryId);
    await pool.query(
      "UPDATE consultation_sessions SET status='paused' WHERE id=$1",
      [ids.session],
    );
    await expect(
      service.claim(
        scope,
        ids.session,
        entryId,
        called,
        estimate(entryId, called),
      ),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);
  });

  it('rejects inconsistent payloads and prevents mutation of persisted evidence', async () => {
    const entryId = await checkedIn('eta-claim-immutable');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, entryId);
    const snapshot = estimate(entryId, source);
    const saved = await service.claim(
      scope,
      ids.session,
      entryId,
      source,
      snapshot,
    );
    const changed: EtaUncertaintySnapshot = {
      ...snapshot,
      earliestMinutes: 1,
      expectedMinutes: 1,
      latestMinutes: 1,
    };
    await expect(
      service.claim(scope, ids.session, entryId, source, changed),
    ).rejects.toBeInstanceOf(EtaPublicationConflictError);
    await expect(
      pool.query('DELETE FROM eta_uncertainty_claims WHERE id=$1', [
        saved.claimId,
      ]),
    ).rejects.toThrow();
    const row = await pool.query(
      'SELECT id FROM eta_uncertainty_claims WHERE id=$1',
      [saved.claimId],
    );
    expect(row.rows).toHaveLength(1);
  });

  it('never grants the claim to an unauthorized or cross-clinic actor', async () => {
    const entryId = await checkedIn('eta-claim-isolation');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, entryId);
    const impostor = { clinicId: ids.otherClinic, actorUserId: ids.actor };
    await expect(
      service.readSourceTuple(impostor, ids.session, entryId),
    ).rejects.toThrow();
    await expect(
      service.claim(
        impostor,
        ids.session,
        entryId,
        source,
        estimate(entryId, source),
      ),
    ).rejects.toThrow();
    const records = await pool.query(
      'SELECT id FROM eta_uncertainty_claims WHERE queue_entry_id=$1',
      [entryId],
    );
    expect(records.rows).toHaveLength(0);
  });

  it('invalidates both source sessions on direct queue transfer', async () => {
    const entryId = await checkedIn('eta-claim-transfer');
    const before = await pool.query<EpochRow>(
      `SELECT session_id,source_epoch FROM eta_session_source_epochs
        WHERE clinic_id=$1 AND session_id IN ($2,$3) ORDER BY session_id`,
      [ids.clinic, ids.session, ids.historicSession],
    );
    expect(before.rows).toHaveLength(2);

    // Service-level transfers obey additional lifecycle constraints. This
    // direct-SQL vector proves DB fencing even for a future writer path.
    await pool.query(
      'UPDATE queue_entries SET session_id=$2 WHERE id=$1',
      [entryId, ids.historicSession],
    );

    const after = await pool.query<EpochRow>(
      `SELECT session_id,source_epoch FROM eta_session_source_epochs
        WHERE clinic_id=$1 AND session_id IN ($2,$3) ORDER BY session_id`,
      [ids.clinic, ids.session, ids.historicSession],
    );
    expect(after.rows).toHaveLength(2);
    for (let index = 0; index < after.rows.length; index++) {
      expect(Number(after.rows[index]!.source_epoch)).toBeGreaterThan(
        Number(before.rows[index]!.source_epoch),
      );
    }
    const service = new EtaUncertaintyClaimService(pool);
    await expect(
      service.readSourceTuple(scope, ids.session, entryId),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);
  });

  it('rejects stale and unsafe direct SQL claims', async () => {
    const entryId = await checkedIn('eta-claim-direct');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, entryId);
    const snapshot = estimate(entryId, source);
    const writeRaw = (epoch: EtaSourceTuple, value: object) => {
      return pool.query(
        `INSERT INTO eta_uncertainty_claims (
           clinic_id,session_id,queue_entry_id,source_epoch,
           clinic_prior_epoch,queue_revision,estimate_version,
           evaluated_at,snapshot
         ) VALUES($1,$2,$3,$4,$5,$6,'eta-uncertainty/v1',$7,$8::jsonb)`,
        [
          ids.clinic,
          ids.session,
          entryId,
          epoch.sourceEpoch,
          epoch.clinicPriorEpoch,
          epoch.queueRevision,
          snapshot.evaluatedAt,
          JSON.stringify(value),
        ],
      );
    };

    await expect(
      writeRaw(source, { ...snapshot, privateDisplayName: 'DO NOT STORE' }),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      writeRaw(source, { ...snapshot, earliestMinutes: -1 }),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      writeRaw(source, {
        ...snapshot,
        explanationCodes: ['hidden-clinic-data'],
      }),
    ).rejects.toMatchObject({ code: '22023' });
    await pool.query(
      `UPDATE consultation_sessions SET delay_version=delay_version+1,
          declared_delay_minutes=9,delay_updated_at=now()
        WHERE id=$1`,
      [ids.session],
    );
    await expect(writeRaw(source, snapshot)).rejects.toMatchObject({
      code: '40001',
    });
  });

  it('keeps committed source epochs across identical read-only observations', async () => {
    const entryId = await checkedIn('eta-claim-stable');
    const service = new EtaUncertaintyClaimService(pool);
    const first = await service.readSourceTuple(scope, ids.session, entryId);
    const second = await service.readSourceTuple(scope, ids.session, entryId);
    expect(second).toEqual(first);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname=current_schema()
          AND indexname='audit_events_eta_reorder_session_idx'`,
    );
    expect(indexes.rows).toHaveLength(1);
  });
});
