import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';
import {
  EtaPublicationClaimService,
  EtaPublicationStaleError,
} from '@/modules/queue-eta-estimator/publication-claims';
import type { EtaUncertaintySnapshot } from '@/modules/queue-eta-estimator/uncertainty-v1';

// TAB-P0-11 / #719: restart and error vectors for ETA publication claims.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
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
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'svc-admin','Admin'),($2,'svc-doc','Doctor')`,
    [ids.admin, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'svc-clinic','Clinic'),($2,'svc-other','Other')`,
    [ids.clinic, ids.otherClinic],
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
const key = () => `svc-${++counter}`;
const svc = () => new EtaPublicationClaimService(pool);

async function openSession() {
  const k = key();
  await new SessionService(pool).command(scope, ids.session, {
    command: 'open',
    idempotencyKey: k,
    correlationId: k,
  });
}
async function register(name: string) {
  const k = key();
  const r = await new QueueService(pool).registerWalkIn(scope, ids.session, {
    privateDisplayName: name,
    preferredLocale: 'fr',
    idempotencyKey: k,
    correlationId: k,
  });
  return r.entry.id;
}
async function checkIn(entryId: string) {
  const k = key();
  await new QueueService(pool).command(scope, ids.session, entryId, {
    command: 'check_in',
    reason: 'svc test',
    cancellationSource: 'clinic',
    idempotencyKey: k,
    correlationId: k,
  });
}

const snap = (
  over: Partial<EtaUncertaintySnapshot> = {},
): EtaUncertaintySnapshot => ({
  earliestMinutes: 10,
  expectedMinutes: 15,
  latestMinutes: 25,
  estimateVersion: 'eta-uncertainty/v1',
  queueRevision: 1,
  evaluatedAt: '2026-09-20T09:30:00.000Z',
  explanationCodes: ['fallback'],
  countdownEligible: true,
  ...over,
});
const claimCount = async () =>
  Number(
    (
      await pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM eta_publication_claims`,
      )
    ).rows[0]!.n,
  );

describe('ETA publication claims: restart and error vectors (real PostgreSQL)', () => {
  it('converges on the persisted claim from a fresh pool and service after a restart', async () => {
    await openSession();
    const entry = await register('Restart one');
    const target = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: entry,
    };
    const first = await svc().publish(target, async () => snap());
    expect(first.outcome).toBe('created');

    const restartedPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
    });
    try {
      const restarted = new EtaPublicationClaimService(restartedPool);
      const again = await restarted.publish(target, async () => snap());
      expect(again.outcome).toBe('existing');
      expect(again.claimId).toBe(first.claimId);
      expect(again.evidenceDigest).toBe(first.evidenceDigest);
    } finally {
      await restartedPool.end();
    }
    expect(await claimCount()).toBe(1);
  });

  it('writes nothing when compute throws and publishes normally afterwards', async () => {
    await openSession();
    const entry = await register('Error one');
    const target = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: entry,
    };
    await expect(
      svc().publish(target, async () => {
        throw new Error('compute failed');
      }),
    ).rejects.toThrow('compute failed');
    expect(await claimCount()).toBe(0);
    const ok = await svc().publish(target, async () => snap());
    expect(ok.outcome).toBe('created');
    expect(await claimCount()).toBe(1);
  });

  it('rejects malformed identifiers and an out-of-clinic session with no write', async () => {
    await openSession();
    const entry = await register('Error two');
    await expect(
      svc().publish(
        { clinicId: 'not-a-uuid', sessionId: ids.session, entryId: entry },
        async () => snap(),
      ),
    ).rejects.toThrow();
    await expect(
      svc().publish(
        { clinicId: ids.otherClinic, sessionId: ids.session, entryId: entry },
        async () => snap(),
      ),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);
    expect(await claimCount()).toBe(0);
  });
});
