import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';
import { EtaPublicationClaimService } from '@/modules/queue-eta-estimator/publication-claims';
import {
  ETA_UNCERTAINTY_VERSION,
  type EtaUncertaintySnapshot,
} from '@/modules/queue-eta-estimator/uncertainty-v1';

// TAB-P0-11 / #587: the ETA contract version is persisted with the claim-only
// publication evidence (epoch-fenced, #610), is DB-enforced and immutable, and
// unrelated queue lifecycle actions never write it.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ids = {
  clinic: randomUUID(),
  admin: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.admin };

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'ver-admin','Admin'),($2,'ver-doc','Doctor')`,
    [ids.admin, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'ver-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'clinic_admin')`,
    [ids.clinic, ids.admin],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,'2026-09-20','2026-09-20 09:00'::timestamptz,'2026-09-20 12:00'::timestamptz,'planned')`,
    [ids.session, ids.clinic, ids.doctor],
  );
});
afterAll(() => pool.end());

let counter = 0;
const key = () => `ver-${++counter}`;

const snap = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    earliestMinutes: 10,
    expectedMinutes: 15,
    latestMinutes: 25,
    estimateVersion: ETA_UNCERTAINTY_VERSION,
    queueRevision: 1,
    evaluatedAt: '2026-09-20T09:30:00.000Z',
    explanationCodes: ['fallback'],
    countdownEligible: true,
    ...over,
  }) as unknown as EtaUncertaintySnapshot;

const claimRows = async () =>
  (
    await pool.query<{ contract_version: string }>(
      `SELECT contract_version FROM eta_publication_claims`,
    )
  ).rows;

async function lifecycle(): Promise<void> {
  const sessions = new SessionService(pool);
  const queue = new QueueService(pool);
  let k = key();
  await sessions.command(scope, ids.session, {
    command: 'open',
    idempotencyKey: k,
    correlationId: k,
  });
  k = key();
  const entry = await queue.registerWalkIn(scope, ids.session, {
    privateDisplayName: 'Version Audit',
    preferredLocale: 'fr',
    idempotencyKey: k,
    correlationId: k,
  });
  k = key();
  await queue.command(scope, ids.session, entry.entry.id, {
    command: 'check_in',
    reason: 'version audit',
    cancellationSource: 'clinic',
    idempotencyKey: k,
    correlationId: k,
  });
}

describe('ETA contract version audit (real PostgreSQL)', () => {
  it('persists exactly the eta-uncertainty/v1 version with a published claim', async () => {
    await lifecycle();
    const entryId = (
      await pool.query<{ id: string }>(`SELECT id FROM queue_entries LIMIT 1`)
    ).rows[0]!.id;
    const service = new EtaPublicationClaimService(pool);
    const result = await service.publish(
      { clinicId: ids.clinic, sessionId: ids.session, entryId },
      async () => snap(),
    );
    expect(result.outcome).toBe('created');
    expect(await claimRows()).toEqual([
      { contract_version: 'eta-uncertainty/v1' },
    ]);
  });

  it('writes no claim for unrelated queue lifecycle actions', async () => {
    await lifecycle();
    expect(await claimRows()).toEqual([]);
  });

  it('refuses a malformed contract version and writes nothing', async () => {
    await lifecycle();
    const entryId = (
      await pool.query<{ id: string }>(`SELECT id FROM queue_entries LIMIT 1`)
    ).rows[0]!.id;
    const service = new EtaPublicationClaimService(pool);
    const epochs = (await service.readSourceEpochs(ids.clinic, ids.session))!;
    for (const bad of ['', 'ETA Uncertainty', 'eta-uncertainty', 'v1']) {
      await expect(
        service.claim(
          { clinicId: ids.clinic, sessionId: ids.session, entryId },
          epochs,
          snap({ estimateVersion: bad }),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect(await claimRows()).toEqual([]);
  });

  it('keeps the stored version immutable', async () => {
    await lifecycle();
    const entryId = (
      await pool.query<{ id: string }>(`SELECT id FROM queue_entries LIMIT 1`)
    ).rows[0]!.id;
    await new EtaPublicationClaimService(pool).publish(
      { clinicId: ids.clinic, sessionId: ids.session, entryId },
      async () => snap(),
    );
    await expect(
      pool.query(`UPDATE eta_publication_claims SET contract_version='x/v2'`),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`DELETE FROM eta_publication_claims`),
    ).rejects.toThrow(/immutable/);
    expect(await claimRows()).toEqual([
      { contract_version: 'eta-uncertainty/v1' },
    ]);
  });
});
