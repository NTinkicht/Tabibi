import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';
import { EtaPublicationClaimService } from '@/modules/queue-eta-estimator/publication-claims';
import type { EtaUncertaintySnapshot } from '@/modules/queue-eta-estimator/uncertainty-v1';

// TAB-P0-11 / #721: readCurrentClaim returns only the newest still-current claim.
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
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'cur-admin','Admin'),($2,'cur-doc','Doctor')`,
    [ids.admin, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'cur-clinic','Clinic'),($2,'cur-other','Other')`,
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
const key = () => `cur-${++counter}`;
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
    reason: 'current claim test',
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

async function step(
  entryId: string,
  command: 'call' | 'start_consultation' | 'complete_consultation',
) {
  const k = key();
  await new QueueService(pool).command(scope, ids.session, entryId, {
    command,
    reason: 'current claim test',
    cancellationSource: 'clinic',
    idempotencyKey: k,
    correlationId: k,
  });
}

async function target() {
  await openSession();
  const entry = await register('Cur one');
  return { clinicId: ids.clinic, sessionId: ids.session, entryId: entry };
}

describe('EtaPublicationClaimService.readCurrentClaim (real PostgreSQL)', () => {
  it('returns null before any claim, then the published claim', async () => {
    const t = await target();
    expect(await svc().readCurrentClaim(t)).toBeNull();
    const published = await svc().publish(t, async () => snap());
    const current = await svc().readCurrentClaim(t);
    expect(current).toEqual({
      claimId: published.claimId,
      evidenceDigest: published.evidenceDigest,
      evaluatedAt: '2026-09-20T09:30:00.000000Z',
    });
    expect(Object.keys(current!).sort()).toEqual([
      'claimId',
      'evaluatedAt',
      'evidenceDigest',
    ]);
  });

  it('returns the newest evaluation and honours the contract version filter', async () => {
    const t = await target();
    const epochs = (await svc().readSourceEpochs(ids.clinic, ids.session))!;
    await svc().claim(t, epochs, snap());
    const newer = await svc().claim(
      t,
      epochs,
      snap({ evaluatedAt: '2026-09-20T09:45:00.000Z' }),
    );
    expect((await svc().readCurrentClaim(t))!.claimId).toBe(newer.claimId);
    expect(
      (await svc().readCurrentClaim(t, 'eta-uncertainty/v1'))!.claimId,
    ).toBe(newer.claimId);
    expect(await svc().readCurrentClaim(t, 'eta-uncertainty/v2')).toBeNull();
  });

  it('preserves microsecond precision of the evaluation instant', async () => {
    const t = await target();
    const epochs = (await svc().readSourceEpochs(ids.clinic, ids.session))!;
    await svc().claim(
      t,
      epochs,
      snap({ evaluatedAt: '2026-09-20T09:30:00.000002Z' }),
    );
    expect((await svc().readCurrentClaim(t))!.evaluatedAt).toBe(
      '2026-09-20T09:30:00.000002Z',
    );
  });

  it('is null once a session source changed, never relabelling the old claim', async () => {
    const t = await target();
    await svc().publish(t, async () => snap());
    await checkIn(t.entryId);
    expect(await svc().readCurrentClaim(t)).toBeNull();
    const fresh = await svc().publish(t, async () => snap());
    expect((await svc().readCurrentClaim(t))!.claimId).toBe(fresh.claimId);
  });

  it('is null after a historical prior change, current again after a republish', async () => {
    await openSession();
    const first = await register('Cur first');
    const waiting = await register('Cur waiting');
    const t = {
      clinicId: ids.clinic,
      sessionId: ids.session,
      entryId: waiting,
    };
    await checkIn(first);
    await step(first, 'call');
    await step(first, 'start_consultation');
    await svc().publish(t, async () => snap());
    expect(await svc().readCurrentClaim(t)).not.toBeNull();
    await step(first, 'complete_consultation');
    expect(await svc().readCurrentClaim(t)).toBeNull();
    const fresh = await svc().publish(t, async () => snap());
    expect((await svc().readCurrentClaim(t))!.claimId).toBe(fresh.claimId);
  });

  it('is tenant-isolated and tuple-bound', async () => {
    const t = await target();
    await svc().publish(t, async () => snap());
    expect(
      await svc().readCurrentClaim({ ...t, clinicId: ids.otherClinic }),
    ).toBeNull();
    expect(
      await svc().readCurrentClaim({ ...t, sessionId: randomUUID() }),
    ).toBeNull();
    expect(
      await svc().readCurrentClaim({ ...t, entryId: randomUUID() }),
    ).toBeNull();
  });

  it('rejects malformed identifiers and versions before any query', async () => {
    const t = await target();
    await expect(
      svc().readCurrentClaim({ ...t, clinicId: 'nope' }),
    ).rejects.toThrow(TypeError);
    await expect(
      svc().readCurrentClaim({ ...t, entryId: "x'; DROP TABLE users;--" }),
    ).rejects.toThrow(TypeError);
    await expect(svc().readCurrentClaim(t, 'Bad Version')).rejects.toThrow(
      RangeError,
    );
  });
});
