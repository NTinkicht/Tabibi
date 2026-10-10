import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
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
import { provisionRuntimeDmlGrants } from '../../scripts/db/runtime-role-grants';

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

describe('WU610: production ETA database privilege boundary', () => {
  it('provisions a login with operational DML but without trigger ownership', async () => {
    const admin = await pool.connect();
    const login =
      'eta_runtime_grants_' + randomUUID().replaceAll('-', '').slice(0, 16);
    const password = randomUUID().replaceAll('-', '');
    const url = new URL(process.env.DATABASE_URL!);
    url.username = login;
    url.password = password;
    let restricted: Pool | undefined;
    try {
      await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}'`);
      const provisionConfig = {
        NODE_ENV: 'production',
        DATABASE_URL: url.toString(),
      };
      // Seed privileges a compromised/old grant could have retained.
      await admin.query(
        `GRANT DELETE ON TABLE public.eta_uncertainty_claims TO "${login}"`,
      );
      await admin.query(
        `GRANT UPDATE ON TABLE public.schema_migrations TO "${login}"`,
      );
      await provisionRuntimeDmlGrants(admin, provisionConfig);
      restricted = new Pool({ connectionString: url.toString(), max: 2 });
      const { assertEtaClaimRuntimeRole } = await import(
        '@/platform/database/eta-claim-runtime-role'
      );
      const client = await restricted.connect();
      try {
        const denied = await client.query<{
          immutable_delete: boolean;
          migration_update: boolean;
        }>(
          `SELECT
             has_table_privilege('public.eta_uncertainty_claims', 'DELETE')
               AS immutable_delete,
             has_table_privilege('public.schema_migrations', 'UPDATE')
               AS migration_update`,
        );
        expect(denied.rows[0]).toEqual({
          immutable_delete: false,
          migration_update: false,
        });
        await expect(
          assertEtaClaimRuntimeRole(client, 'production'),
        ).resolves.toBeUndefined();
        await expect(
          client.query(
            'ALTER TABLE public.eta_uncertainty_claims DISABLE TRIGGER eta_guard_claim_publication_insert',
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        client.release();
      }
      const service = new QueueService(restricted);
      const admitted = await service.registerWalkIn(scope, ids.session, {
        privateDisplayName: 'restricted-login-claim',
        preferredLocale: 'fr',
        idempotencyKey: 'restricted-role-register',
        correlationId: 'restricted-role-register',
      });
      await service.command(scope, ids.session, admitted.entry.id, {
        command: 'check_in',
        idempotencyKey: 'restricted-role-checkin',
        correlationId: 'restricted-role-checkin',
      });
      const published = await new EtaUncertaintyClaimService(
        restricted,
      ).claimCurrent(
        scope,
        ids.session,
        admitted.entry.id,
        'restricted-role-publish',
      );
      expect(published.snapshot.estimateVersion).toBe('eta-uncertainty/v1');
      // WU192's SECURITY INVOKER trigger also INSERTs and DELETEs a
      // doctor-global active guard row; the runtime must have exact DML.
      await service.command(scope, ids.session, admitted.entry.id, {
        command: 'call',
        idempotencyKey: 'restricted-role-call',
        correlationId: 'restricted-role-call',
      });
      await service.command(scope, ids.session, admitted.entry.id, {
        command: 'start_consultation',
        idempotencyKey: 'restricted-role-start',
        correlationId: 'restricted-role-start',
      });
      const active = await restricted.query<{ queue_entry_id: string }>(
        'SELECT queue_entry_id FROM doctor_active_consultations WHERE doctor_id=$1',
        [ids.doctor],
      );
      expect(active.rows[0]?.queue_entry_id).toBe(admitted.entry.id);
      await service.command(scope, ids.session, admitted.entry.id, {
        command: 'complete_consultation',
        idempotencyKey: 'restricted-role-complete',
        correlationId: 'restricted-role-complete',
      });
      const cleared = await restricted.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM doctor_active_consultations WHERE doctor_id=$1',
        [ids.doctor],
      );
      expect(cleared.rows[0]?.count).toBe('0');
    } finally {
      if (restricted) await restricted.end();
      await admin.query(`DROP OWNED BY "${login}"`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS "${login}"`);
      admin.release();
    }
  });

  it('rejects owner SET ROLE masquerading but permits a genuinely restricted login', async () => {
    const { assertEtaClaimRuntimeRole } = await import(
      '@/platform/database/eta-claim-runtime-role'
    );
    const admin = await pool.connect();
    const restrictedRole =
      'eta_runtime_probe_' + randomUUID().replaceAll('-', '').slice(0, 16);
    const password = randomUUID().replaceAll('-', '');
    const restrictedConnection = new URL(process.env.DATABASE_URL!);
    restrictedConnection.username = restrictedRole;
    restrictedConnection.password = password;
    let app: Client | undefined;
    try {
      await expect(
        assertEtaClaimRuntimeRole(admin, 'production'),
      ).rejects.toThrow(/privileged/);
      await admin.query(
        `CREATE ROLE "${restrictedRole}" LOGIN PASSWORD '${password}'`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA public TO "${restrictedRole}"`);
      await admin.query(
        `GRANT SELECT, INSERT ON eta_uncertainty_claims TO "${restrictedRole}"`,
      );
      await admin.query('BEGIN');
      await admin.query(`SET LOCAL ROLE "${restrictedRole}"`);
      // current_user alone looks safe here, but session_user remains owner.
      await expect(
        assertEtaClaimRuntimeRole(admin, 'production'),
      ).rejects.toThrow(/privileged/);
      await admin.query('ROLLBACK');

      app = new Client({ connectionString: restrictedConnection.toString() });
      await app.connect();
      await expect(
        assertEtaClaimRuntimeRole(app, 'production'),
      ).resolves.toBeUndefined();
      await app.query('BEGIN');
      await expect(
        app.query(
          'ALTER TABLE public.eta_uncertainty_claims DISABLE TRIGGER eta_guard_claim_publication_insert',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await app.query('ROLLBACK');
    } finally {
      if (app) await app.end();
      await admin.query('ROLLBACK').catch(() => undefined);
      await admin
        .query(`DROP OWNED BY "${restrictedRole}"`)
        .catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS "${restrictedRole}"`);
      admin.release();
    }
  });
});

describe('WU610: atomic, immutable ETA claim publication', () => {
  it('accepts one exact-source claim and converges concurrent identical retries', async () => {
    const entryId = await checkedIn('eta-claim-first');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, entryId);
    const [issued, concurrent] = await Promise.all([
      service.claimCurrent(scope, ids.session, entryId, `eta-claim-${entryId}`),
      service.claimCurrent(scope, ids.session, entryId, `eta-claim-${entryId}`),
    ]);
    expect(concurrent).toEqual(issued);
    const claims = await Promise.all([
      service.claim(scope, ids.session, entryId, source, issued.snapshot),
      service.claim(scope, ids.session, entryId, source, issued.snapshot),
    ]);
    expect(claims[0]).toEqual(claims[1]);
    expect(claims[0]).toEqual(issued);
    const same = await service.claim(
      scope,
      ids.session,
      entryId,
      source,
      issued.snapshot,
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
    const newer = await service.claimCurrent(
      scope,
      ids.session,
      entryId,
      `eta-claim-${entryId}`,
    );
    expect(newer.snapshot.expectedMinutes).toBe(25);
  });

  it('rejects a stale candidate stamped with newer source epochs', async () => {
    const entryId = await checkedIn('eta-claim-provenance');
    const service = new EtaUncertaintyClaimService(pool);
    const oldSource = await service.readSourceTuple(
      scope,
      ids.session,
      entryId,
    );
    const oldEstimate = estimate(entryId, oldSource);
    await pool.query(
      `UPDATE consultation_sessions
          SET declared_delay_minutes=30,delay_version=delay_version+1,
              delay_updated_at=now()
        WHERE id=$1 AND clinic_id=$2`,
      [ids.session, ids.clinic],
    );
    const freshSource = await service.readSourceTuple(
      scope,
      ids.session,
      entryId,
    );
    expect(freshSource.queueRevision).toBe(oldSource.queueRevision);
    expect(freshSource.sourceEpoch).toBeGreaterThan(oldSource.sourceEpoch);
    await expect(
      service.claim(scope, ids.session, entryId, freshSource, oldEstimate),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);
    const valid = await service.claimCurrent(
      scope,
      ids.session,
      entryId,
      `eta-claim-${entryId}`,
    );
    expect(valid.snapshot.expectedMinutes).toBe(30);
  });

  it('replays a previously committed claim after source epochs advance', async () => {
    const entryId = await checkedIn('eta-claim-lost-response');
    const service = new EtaUncertaintyClaimService(pool);
    const oldSource = await service.readSourceTuple(
      scope,
      ids.session,
      entryId,
    );
    const first = await service.claimCurrent(
      scope,
      ids.session,
      entryId,
      `eta-claim-${entryId}`,
    );
    const oldEstimate = first.snapshot;
    await pool.query(
      `UPDATE consultation_sessions
          SET declared_delay_minutes=9,delay_version=delay_version+1,
              delay_updated_at=now()
        WHERE id=$1 AND clinic_id=$2`,
      [ids.session, ids.clinic],
    );
    const replay = await service.claim(
      scope,
      ids.session,
      entryId,
      oldSource,
      oldEstimate,
    );
    expect(replay).toEqual(first);
    // Simulate an acknowledgement lost after COMMIT: the caller knows only
    // its stable request key, not the issued timestamp or claim identifier.
    const lostAckReplay = await service.claimCurrent(
      scope,
      ids.session,
      entryId,
      `eta-claim-${entryId}`,
    );
    expect(lostAckReplay).toEqual(first);
    expect(JSON.stringify(lostAckReplay.snapshot)).toBe(
      JSON.stringify(first.snapshot),
    );
    expect(Object.isFrozen(lostAckReplay.snapshot)).toBe(true);
    expect(Object.isFrozen(lostAckReplay.snapshot.explanationCodes)).toBe(true);
    const receiptRows = await pool.query(
      'SELECT claim_id FROM eta_claim_idempotency_receipts WHERE clinic_id=$1',
      [ids.clinic],
    );
    expect(receiptRows.rows).toHaveLength(1);
    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM eta_uncertainty_claims WHERE queue_entry_id=$1',
      [entryId],
    );
    expect(count.rows[0]?.count).toBe('1');
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
    const saved = await service.claimCurrent(
      scope,
      ids.session,
      entryId,
      `eta-claim-${entryId}`,
    );
    const changed: EtaUncertaintySnapshot = {
      ...saved.snapshot,
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

  it('uses the database transaction clock instead of arbitrary supplied times', async () => {
    const entryId = await checkedIn('eta-claim-trusted-clock');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, entryId);
    const oldTimestamp = estimate(entryId, source);
    const futureTimestamp: EtaUncertaintySnapshot = {
      ...oldTimestamp,
      evaluatedAt: '2049-01-01T23:59:59.000Z',
    };
    await expect(
      service.claim(scope, ids.session, entryId, source, oldTimestamp),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);
    await expect(
      service.claim(scope, ids.session, entryId, source, futureTimestamp),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);

    const before = await pool.query<{ clock_at: Date }>(
      'SELECT clock_timestamp() AS clock_at',
    );
    const saved = await service.claimCurrent(
      scope,
      ids.session,
      entryId,
      `eta-claim-${entryId}`,
    );
    const after = await pool.query<{ clock_at: Date }>(
      'SELECT clock_timestamp() AS clock_at',
    );
    const evaluated = new Date(saved.snapshot.evaluatedAt).getTime();
    expect(evaluated).toBeGreaterThanOrEqual(
      before.rows[0]!.clock_at.getTime(),
    );
    expect(evaluated).toBeLessThanOrEqual(after.rows[0]!.clock_at.getTime());
    expect(saved.snapshot.evaluatedAt).not.toBe(oldTimestamp.evaluatedAt);
    expect(saved.snapshot.evaluatedAt).not.toBe(futureTimestamp.evaluatedAt);
    expect(
      await service.claim(scope, ids.session, entryId, source, saved.snapshot),
    ).toEqual(saved);
  });

  it('binds a request key to one clinic-scoped target and rejects invalid keys', async () => {
    const firstId = await checkedIn('eta-claim-key-one');
    const service = new EtaUncertaintyClaimService(pool);
    await expect(
      service.claimCurrent(scope, ids.session, firstId, 'contains spaces'),
    ).rejects.toBeInstanceOf(RangeError);
    const committed = await service.claimCurrent(
      scope,
      ids.session,
      firstId,
      'stable-claim-001',
    );
    const secondId = await checkedIn('eta-claim-key-two');
    await expect(
      service.claimCurrent(scope, ids.session, secondId, 'stable-claim-001'),
    ).rejects.toBeInstanceOf(EtaPublicationConflictError);
    const replay = await service.claimCurrent(
      scope,
      ids.session,
      firstId,
      'stable-claim-001',
    );
    expect(replay).toEqual(committed);
    await expect(
      pool.query(
        `UPDATE eta_claim_idempotency_receipts
            SET request_key='rewritten' WHERE clinic_id=$1`,
        [ids.clinic],
      ),
    ).rejects.toThrow();
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
    await pool.query('UPDATE queue_entries SET session_id=$2 WHERE id=$1', [
      entryId,
      ids.historicSession,
    ]);

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

  it('rejects stale evidence from a long-held publishing transaction', async () => {
    const entryId = await checkedIn('eta-claim-aged-transaction');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, entryId);
    const direct = await pool.connect();
    try {
      await direct.query('BEGIN');
      const timestamp = await direct.query<{ evaluated_at: Date }>(
        "SELECT date_trunc('milliseconds', transaction_timestamp()) AS evaluated_at",
      );
      const evaluatedAt = timestamp.rows[0]!.evaluated_at.toISOString();
      const snapshot = { ...estimate(entryId, source), evaluatedAt };
      // A transaction older than the bounded freshness budget is rejected
      // even if it still holds unchanged source epochs.
      await direct.query('SELECT pg_sleep(5.2)');
      await expect(
        direct.query(
          `INSERT INTO eta_uncertainty_claims (
             clinic_id,session_id,queue_entry_id,source_epoch,
             clinic_prior_epoch,queue_revision,estimate_version,
             evaluated_at,snapshot
           ) VALUES($1,$2,$3,$4,$5,$6,'eta-uncertainty/v1',$7,$8::jsonb)`,
          [
            ids.clinic,
            ids.session,
            entryId,
            source.sourceEpoch,
            source.clinicPriorEpoch,
            source.queueRevision,
            evaluatedAt,
            JSON.stringify(snapshot),
          ],
        ),
      ).rejects.toMatchObject({ code: '22023' });
      await direct.query('ROLLBACK');
    } finally {
      direct.release();
    }
  }, 15_000);

  it('uses committed public ETA sources despite hostile temporary search-path shadowing', async () => {
    await checkedIn('eta-claim-real-source-first');
    const target = await checkedIn('eta-claim-real-source-target');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, target);
    const actor = await pool.connect();
    try {
      await actor.query('BEGIN');
      await actor.query(
        'CREATE TEMP TABLE queue_entries (LIKE public.queue_entries) ON COMMIT DROP',
      );
      await actor.query(
        'CREATE TEMP TABLE consultation_sessions (LIKE public.consultation_sessions) ON COMMIT DROP',
      );
      await actor.query('SET LOCAL search_path TO pg_temp, public');
      const actual = await actor.query<{ snapshot: EtaUncertaintySnapshot }>(
        `SELECT public.eta_expected_claim_snapshot(
           $1,$2,$3,$4,date_trunc('milliseconds',transaction_timestamp())
         ) AS snapshot`,
        [ids.clinic, ids.session, target, source.queueRevision],
      );
      expect(actual.rows[0]?.snapshot?.expectedMinutes).toBeGreaterThan(0);
      expect(actual.rows[0]?.snapshot?.explanationCodes).toContain(
        'queue-depth',
      );
      await actor.query('ROLLBACK');
    } catch (error) {
      await actor.query('ROLLBACK');
      throw error;
    } finally {
      actor.release();
    }
  });

  it('rejects forged but shape-valid ETA numbers even with current epochs and transaction time', async () => {
    await checkedIn('eta-claim-ahead-first');
    const target = await checkedIn('eta-claim-forged-target');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, target);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const time = await client.query<{ evaluated_at: Date }>(
        "SELECT date_trunc('milliseconds', transaction_timestamp()) AS evaluated_at",
      );
      const trustedAt = time.rows[0]!.evaluated_at.toISOString();
      // Shape and all epochs are genuine; only the advertised ETA is forged.
      // The actual queue contains an eligible service slot ahead of target.
      const forged = {
        ...estimate(target, source),
        evaluatedAt: trustedAt,
        earliestMinutes: 0,
        expectedMinutes: 0,
        latestMinutes: 0,
        explanationCodes: ['fallback'],
      };
      await expect(
        client.query(
          `INSERT INTO eta_uncertainty_claims (
            clinic_id,session_id,queue_entry_id,source_epoch,
            clinic_prior_epoch,queue_revision,estimate_version,
            evaluated_at,snapshot
          ) VALUES ($1,$2,$3,$4,$5,$6,'eta-uncertainty/v1',$7,$8::jsonb)`,
          [
            ids.clinic,
            ids.session,
            target,
            source.sourceEpoch,
            source.clinicPriorEpoch,
            source.queueRevision,
            trustedAt,
            JSON.stringify(forged),
          ],
        ),
      ).rejects.toMatchObject({ code: '22023' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const valid = await service.claimCurrent(
      scope,
      ids.session,
      target,
      `canonical-${target}`,
    );
    expect(valid.snapshot.expectedMinutes).toBeGreaterThan(0);
    expect(valid.snapshot.explanationCodes).toContain('queue-depth');
  });

  it('rejects stale and unsafe direct SQL claims', async () => {
    const entryId = await checkedIn('eta-claim-direct');
    const service = new EtaUncertaintyClaimService(pool);
    const source = await service.readSourceTuple(scope, ids.session, entryId);
    const clock = await pool.query<{ evaluated_at: Date }>(
      'SELECT clock_timestamp() AS evaluated_at',
    );
    const snapshot: EtaUncertaintySnapshot = {
      ...estimate(entryId, source),
      evaluatedAt: clock.rows[0]!.evaluated_at.toISOString(),
    };
    const writeRaw = (
      epoch: EtaSourceTuple,
      value: object,
      at = snapshot.evaluatedAt,
    ) => {
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
          at,
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
    // A direct SQL writer must also fail closed on arbitrary evaluation
    // times, even when all seven evidence fields are otherwise normalized.
    const pastInstant = '2026-09-08T10:05:30.000Z';
    await expect(
      writeRaw(source, { ...snapshot, evaluatedAt: pastInstant }, pastInstant),
    ).rejects.toMatchObject({ code: '22023' });
    const fourMinutesAgo = new Date(
      clock.rows[0]!.evaluated_at.getTime() - 4 * 60_000,
    ).toISOString();
    await expect(
      writeRaw(
        source,
        { ...snapshot, evaluatedAt: fourMinutesAgo },
        fourMinutesAgo,
      ),
    ).rejects.toMatchObject({ code: '22023' });
    // A direct SQL insert may create evidence only at the exact trusted
    // transaction timestamp, never at a clock value chosen by the caller.
    const direct = await pool.connect();
    try {
      await direct.query('BEGIN');
      const timestamp = await direct.query<{ evaluated_at: Date }>(
        "SELECT date_trunc('milliseconds', transaction_timestamp()) AS evaluated_at",
      );
      const canonical = timestamp.rows[0]!.evaluated_at.toISOString();
      const compliant = { ...snapshot, evaluatedAt: canonical };
      await direct.query(
        `INSERT INTO eta_uncertainty_claims (
           clinic_id,session_id,queue_entry_id,source_epoch,
           clinic_prior_epoch,queue_revision,estimate_version,
           evaluated_at,snapshot
         ) VALUES($1,$2,$3,$4,$5,$6,'eta-uncertainty/v1',$7,$8::jsonb)`,
        [
          ids.clinic,
          ids.session,
          entryId,
          source.sourceEpoch,
          source.clinicPriorEpoch,
          source.queueRevision,
          canonical,
          JSON.stringify(compliant),
        ],
      );
      await direct.query('COMMIT');
    } catch (error) {
      await direct.query('ROLLBACK');
      throw error;
    } finally {
      direct.release();
    }
    const futureInstant = '2049-01-01T23:59:59.000Z';
    await expect(
      writeRaw(
        source,
        { ...snapshot, evaluatedAt: futureInstant },
        futureInstant,
      ),
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

  it('takes clinic-prior epoch locks in canonical order for opposing transfers', async () => {
    const before = await pool.query<{ clinic_id: string; prior_epoch: string }>(
      `SELECT clinic_id,prior_epoch FROM eta_clinic_prior_epochs
         WHERE clinic_id IN ($1,$2) ORDER BY clinic_id`,
      [ids.clinic, ids.otherClinic],
    );
    expect(before.rows).toHaveLength(2);

    const transfer = async (from: string, to: string) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '4s'");
        await client.query(
          'SELECT eta_increment_affected_prior_epochs($1,$2,true,true)',
          [from, to],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    // Both worker transactions request the same two clinic rows in opposite
    // logical transfer directions; row-lock acquisition must still be sorted.
    await Promise.all([
      transfer(ids.clinic, ids.otherClinic),
      transfer(ids.otherClinic, ids.clinic),
    ]);
    const after = await pool.query<{ clinic_id: string; prior_epoch: string }>(
      `SELECT clinic_id,prior_epoch FROM eta_clinic_prior_epochs
         WHERE clinic_id IN ($1,$2) ORDER BY clinic_id`,
      [ids.clinic, ids.otherClinic],
    );
    for (let i = 0; i < before.rows.length; i++) {
      expect(after.rows[i]!.clinic_id).toBe(before.rows[i]!.clinic_id);
      expect(Number(after.rows[i]!.prior_epoch)).toBe(
        Number(before.rows[i]!.prior_epoch) + 2,
      );
    }
  });

  it('avoids deadlocks for opposing concurrently corrected reorder audits', async () => {
    const initial = await pool.query<{ id: string }>(
      `INSERT INTO audit_events(
         clinic_id, actor_user_id, entity_type, entity_id, action, metadata
       ) VALUES
         ($1,$2,'consultation_session',$3::uuid,'queue_entry.reordered',
          jsonb_build_object('sessionId',$3::uuid::text,'resultingOrder','[]'::jsonb)),
         ($1,$2,'consultation_session',$4::uuid,'queue_entry.reordered',
          jsonb_build_object('sessionId',$4::uuid::text,'resultingOrder','[]'::jsonb))
       RETURNING id::text`,
      [ids.clinic, ids.actor, ids.session, ids.historicSession],
    );
    expect(initial.rows).toHaveLength(2);

    const before = await pool.query<EpochRow>(
      `SELECT session_id, source_epoch FROM eta_session_source_epochs
        WHERE clinic_id=$1 ORDER BY session_id`,
      [ids.clinic],
    );
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
      await Promise.all([
        first.query("SET LOCAL lock_timeout = '5s'"),
        second.query("SET LOCAL lock_timeout = '5s'"),
      ]);

      // Both updates start at the same JS barrier and touch separate audit
      // rows. Their old/new session epoch pairs are reversed: A->B, B->A.
      // Each transaction commits immediately after its own update so a
      // well-ordered contender can make progress without waiting for the
      // other contender's UPDATE to finish before either COMMIT occurs.
      let openBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        openBarrier = resolve;
      });
      const move = async (
        client: typeof first,
        auditId: string,
        sessionId: string,
      ) => {
        await barrier;
        await client.query(
          `UPDATE audit_events SET metadata=jsonb_set(
             metadata, '{sessionId}', to_jsonb($2::text))
            WHERE id=$1`,
          [auditId, sessionId],
        );
        await client.query('COMMIT');
      };
      const changes = [
        move(first, initial.rows[0]!.id, ids.historicSession),
        move(second, initial.rows[1]!.id, ids.session),
      ];
      openBarrier();
      await Promise.all(changes);
    } finally {
      await Promise.all([
        first.query('ROLLBACK').catch(() => undefined),
        second.query('ROLLBACK').catch(() => undefined),
      ]);
      first.release();
      second.release();
    }

    const after = await pool.query<EpochRow>(
      `SELECT session_id, source_epoch FROM eta_session_source_epochs
        WHERE clinic_id=$1 ORDER BY session_id`,
      [ids.clinic],
    );
    expect(after.rows).toHaveLength(2);
    for (let index = 0; index < 2; index++) {
      expect(Number(after.rows[index]!.source_epoch)).toBe(
        Number(before.rows[index]!.source_epoch) + 2,
      );
    }
    const audit = await pool.query<{ session_id: string }>(
      `SELECT metadata->>'sessionId' AS session_id FROM audit_events
        WHERE id=ANY($1::bigint[]) ORDER BY id`,
      [initial.rows.map((row) => row.id)],
    );
    expect(audit.rows.map((row) => row.session_id)).toEqual([
      ids.historicSession,
      ids.session,
    ]);
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
