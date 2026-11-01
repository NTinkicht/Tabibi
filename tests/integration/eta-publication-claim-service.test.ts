import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';
import {
  EtaClaimDigestConflictError,
  EtaPublicationClaimService,
  EtaPublicationStaleError,
} from '@/modules/queue-eta-estimator/publication-claims';
import type { EtaUncertaintySnapshot } from '@/modules/queue-eta-estimator/uncertainty-v1';

// TAB-P0-11 / #610 slice 4: service adapter over claim_eta_publication.
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

describe('EtaPublicationClaimService (real PostgreSQL)', () => {
  it('reads epochs and publishes created then existing on an identical retry', async () => {
    await openSession();
    const entry = await register('Svc one');
    const target = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: entry,
    };
    const epochs = await svc().readSourceEpochs(ids.clinic, ids.session);
    expect(epochs).not.toBeNull();
    const first = await svc().publish(target, async () => snap());
    expect(first.outcome).toBe('created');
    const again = await svc().publish(target, async () => snap());
    expect(again.outcome).toBe('existing');
    expect(again.claimId).toBe(first.claimId);
    expect(await claimCount()).toBe(1);
  });

  it('returns stale from claim() once a source changed and writes nothing', async () => {
    await openSession();
    const entry = await register('Svc two');
    const target = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: entry,
    };
    const before = (await svc().readSourceEpochs(ids.clinic, ids.session))!;
    await checkIn(entry);
    const after = (await svc().readSourceEpochs(ids.clinic, ids.session))!;
    expect(after.sessionEpoch).toBeGreaterThan(before.sessionEpoch);
    const stale = await svc().claim(target, before, snap());
    expect(stale).toEqual({
      outcome: 'stale',
      claimId: null,
      evidenceDigest: null,
    });
    expect(await claimCount()).toBe(0);
  });

  it('recomputes from a fresh snapshot when a source moves mid-publish', async () => {
    await openSession();
    const entry = await register('Svc three');
    const target = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: entry,
    };
    let calls = 0;
    const result = await svc().publish(target, async (epochs) => {
      calls += 1;
      if (calls === 1) await checkIn(entry); // source change after the epoch read
      return snap({ queueRevision: 100 + epochs.sessionEpoch });
    });
    expect(calls).toBe(2);
    expect(result.outcome).toBe('created');
    const row = (
      await pool.query<{ session_epoch: string }>(
        `SELECT session_epoch::text FROM eta_publication_claims`,
      )
    ).rows;
    expect(row).toHaveLength(1);
    const current = (await svc().readSourceEpochs(ids.clinic, ids.session))!;
    expect(Number(row[0]!.session_epoch)).toBe(current.sessionEpoch);
  });

  it('gives up with a stale error when the source keeps moving, publishing nothing', async () => {
    await openSession();
    const entry = await register('Svc four');
    const target = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: entry,
    };
    await expect(
      svc().publish(
        target,
        async () => {
          await pool.query(
            `UPDATE consultation_sessions
                SET delay_version = delay_version + 1,
                    declared_delay_minutes = COALESCE(declared_delay_minutes, 0) + 5,
                    delay_updated_at = now()
              WHERE id=$1`,
            [ids.session],
          );
          return snap();
        },
        2,
      ),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);
    expect(await claimCount()).toBe(0);
  });

  it('refuses a same-tuple different-digest retry as a typed conflict', async () => {
    await openSession();
    const entry = await register('Svc five');
    const target = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: entry,
    };
    const epochs = (await svc().readSourceEpochs(ids.clinic, ids.session))!;
    await svc().claim(target, epochs, snap());
    await expect(
      svc().claim(target, epochs, snap({ expectedMinutes: 16 })),
    ).rejects.toBeInstanceOf(EtaClaimDigestConflictError);
    expect(await claimCount()).toBe(1);
  });

  it('is tenant-isolated: another clinic neither reads epochs nor claims', async () => {
    await openSession();
    const entry = await register('Svc six');
    expect(
      await svc().readSourceEpochs(ids.otherClinic, ids.session),
    ).toBeNull();
    const epochs = (await svc().readSourceEpochs(ids.clinic, ids.session))!;
    const result = await svc().claim(
      { clinicId: ids.otherClinic, sessionId: ids.session, entryId: entry },
      epochs,
      snap(),
    );
    expect(result.outcome).toBe('stale');
    expect(await claimCount()).toBe(0);
  });

  it('keeps distinct microsecond evaluations as distinct claims', async () => {
    await openSession();
    const entry = await register('Svc micro');
    const target = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: entry,
    };
    const epochs = (await svc().readSourceEpochs(ids.clinic, ids.session))!;
    const a = await svc().claim(
      target,
      epochs,
      snap({ evaluatedAt: '2026-09-20T09:30:00.000001Z' }),
    );
    const b = await svc().claim(
      target,
      epochs,
      snap({ evaluatedAt: '2026-09-20T09:30:00.000002Z' }),
    );
    expect(a.outcome).toBe('created');
    expect(b.outcome).toBe('created');
    expect(a.claimId).not.toBe(b.claimId);
    const again = await svc().claim(
      target,
      epochs,
      snap({ evaluatedAt: '2026-09-20T09:30:00.000001Z' }),
    );
    expect(again.outcome).toBe('existing');
    expect(await claimCount()).toBe(2);
  });

  it('concurrent identical publishes converge on one claim', async () => {
    await openSession();
    const entry = await register('Svc seven');
    const target = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: entry,
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        svc().publish(target, async () => snap()),
      ),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(new Set(results.map((r) => r.claimId)).size).toBe(1);
    expect(await claimCount()).toBe(1);
  });
});
