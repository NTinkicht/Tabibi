import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';
import {
  EtaNotPublishableError,
  ReceptionistEtaPublisher,
} from '@/modules/queue-eta-estimator/receptionist-publication';
import { ReceptionistDashboardService } from '@/modules/receptionist-dashboard';
import { AuthorizationError } from '@/modules/identity';

// TAB-P0-11 / #715: staff-side ETA publication through the claim service.
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
const NOW = new Date('2026-09-20T09:30:00.000Z');
const publisher = () =>
  new ReceptionistEtaPublisher(
    pool,
    new ReceptionistDashboardService(pool, () => NOW),
  );

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

const claimCount = async () =>
  Number(
    (
      await pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM eta_publication_claims`,
      )
    ).rows[0]!.n,
  );

describe('ReceptionistEtaPublisher (real PostgreSQL)', () => {
  it('publishes a checked-in entry once and converges on an identical retry', async () => {
    await openSession();
    const entry = await register('Pub one');
    await checkIn(entry);
    const first = await publisher().publishForEntry(scope, ids.session, entry);
    expect(first.outcome).toBe('created');
    const again = await publisher().publishForEntry(scope, ids.session, entry);
    expect(again.outcome).toBe('existing');
    expect(again.claimId).toBe(first.claimId);
    expect(await claimCount()).toBe(1);
  });

  it('refuses a waiting entry without writing a claim', async () => {
    await openSession();
    const entry = await register('Pub waiting');
    await expect(
      publisher().publishForEntry(scope, ids.session, entry),
    ).rejects.toBeInstanceOf(EtaNotPublishableError);
    expect(await claimCount()).toBe(0);
  });

  it('refuses a user without a staff membership before any claim', async () => {
    await openSession();
    const entry = await register('Pub authz');
    await checkIn(entry);
    await expect(
      publisher().publishForEntry(
        { clinicId: ids.clinic, actorUserId: ids.doctorUser },
        ids.session,
        entry,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await claimCount()).toBe(0);
  });

  it('refuses a session that belongs to another clinic (tenant isolation)', async () => {
    await openSession();
    const entry = await register('Pub tenant');
    await checkIn(entry);
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'clinic_admin')`,
      [ids.otherClinic, ids.admin],
    );
    await expect(
      publisher().publishForEntry(
        { clinicId: ids.otherClinic, actorUserId: ids.admin },
        ids.session,
        entry,
      ),
    ).rejects.toThrow();
    expect(await claimCount()).toBe(0);
  });

  it('a source change between publications yields a new claim, never a relabelled one', async () => {
    await openSession();
    const a = await register('Pub A');
    await checkIn(a);
    const first = await publisher().publishForEntry(scope, ids.session, a);
    const b = await register('Pub B');
    await checkIn(b);
    const second = await publisher().publishForEntry(scope, ids.session, b);
    expect(second.claimId).not.toBe(first.claimId);
    expect(await claimCount()).toBe(2);
  });
});
