import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { SessionService } from '@/modules/session';

// TAB-P0-11 / #610 slice 3: claim-only ETA publication with an atomic epoch CAS.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  doctorUser: randomUUID(),
  doctorUser2: randomUUID(),
  doctor: randomUUID(),
  doctor2: randomUUID(),
  session: randomUUID(),
  sibling: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.admin };

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'claim-admin','Admin'),($2,'claim-doc','Doctor'),($3,'claim-doc2','Doctor 2')`,
    [ids.admin, ids.doctorUser, ids.doctorUser2],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'claim-clinic','Clinic'),($2,'claim-other','Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'clinic_admin')`,
    [ids.clinic, ids.admin],
  );
  for (const [doctor, user] of [
    [ids.doctor, ids.doctorUser],
    [ids.doctor2, ids.doctorUser2],
  ] as const) {
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
      [doctor, user],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [ids.clinic, doctor],
    );
  }
  for (const [id, hour, endHour] of [
    [ids.session, '09:00', '12:00'],
    [ids.sibling, '13:00', '16:00'],
  ] as const) {
    await pool.query(
      `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES($1,$2,$3,'2026-09-20',('2026-09-20 '||$4)::timestamptz,('2026-09-20 '||$5)::timestamptz,'planned')`,
      [id, ids.clinic, ids.doctor, hour, endHour],
    );
  }
});
afterAll(() => pool.end());

let counter = 0;
const key = () => `prior-${++counter}`;
const sessions = () => new SessionService(pool);
const queue = () => new QueueService(pool);

async function openSession() {
  const k = key();
  await sessions().command(scope, ids.session, {
    command: 'open',
    idempotencyKey: k,
    correlationId: k,
  });
}

async function register(name: string) {
  const k = key();
  const registered = await queue().registerWalkIn(scope, ids.session, {
    privateDisplayName: name,
    preferredLocale: 'fr',
    idempotencyKey: k,
    correlationId: k,
  });
  return registered.entry.id;
}

function entryCommand(
  entryId: string,
  command:
    | 'check_in'
    | 'call'
    | 'start_consultation'
    | 'complete_consultation'
    | 'cancel',
) {
  const k = key();
  return queue().command(scope, ids.session, entryId, {
    command,
    reason: 'prior epoch test',
    cancellationSource: 'clinic',
    idempotencyKey: k,
    correlationId: k,
  });
}

async function runToStart(entryId: string) {
  for (const step of ['check_in', 'call', 'start_consultation'] as const)
    await entryCommand(entryId, step);
}

const V1 = 'eta-uncertainty/v1';
const T0 = '2026-09-20T09:30:00.000Z';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

type Outcome = {
  outcome: string;
  claim_id: string | null;
  claimed_digest: string | null;
};

async function claim(
  entry: string,
  sessionEpoch: number,
  priorEpoch: number,
  d = digest('a'),
  opts: {
    clinic?: string;
    version?: string;
    at?: string;
    session?: string;
  } = {},
  db: Pool = pool,
): Promise<Outcome> {
  const r = await db.query<Outcome>(
    `SELECT * FROM claim_eta_publication($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      opts.clinic ?? ids.clinic,
      opts.session ?? ids.session,
      entry,
      sessionEpoch,
      priorEpoch,
      opts.version ?? V1,
      opts.at ?? T0,
      d,
    ],
  );
  return r.rows[0]!;
}

async function priorEpoch(): Promise<number> {
  const r = await pool.query<{ e: string }>(
    `SELECT eta_prior_epoch::text AS e FROM clinic_doctor_eta_prior_epochs WHERE clinic_id=$1 AND doctor_id=$2`,
    [ids.clinic, ids.doctor],
  );
  return r.rows[0] ? Number(r.rows[0].e) : 0;
}
async function sessionEpoch(): Promise<number> {
  const r = await pool.query<{ e: string }>(
    `SELECT eta_source_epoch::text AS e FROM consultation_sessions WHERE id=$1`,
    [ids.session],
  );
  return Number(r.rows[0]!.e);
}
async function claimCount(): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM eta_publication_claims`,
  );
  return Number(r.rows[0]!.n);
}

describe('eta_publication_claims (real PostgreSQL)', () => {
  it('creates a claim at the current epochs and returns existing for an identical retry', async () => {
    await openSession();
    const entry = await register('Claim one');
    const se = await sessionEpoch();
    const first = await claim(entry, se, 0);
    expect(first.outcome).toBe('created');
    const again = await claim(entry, se, 0);
    expect(again.outcome).toBe('existing');
    expect(again.claim_id).toBe(first.claim_id);
    expect(again.claimed_digest).toBe(digest('a'));
    expect(await claimCount()).toBe(1);
  });

  it('refuses a same-tuple retry with a different digest and writes nothing', async () => {
    await openSession();
    const entry = await register('Claim two');
    const se = await sessionEpoch();
    await claim(entry, se, 0);
    await expect(claim(entry, se, 0, digest('b'))).rejects.toMatchObject({
      code: '23505',
    });
    expect(await claimCount()).toBe(1);
  });

  it('is stale (zero rows) after any source change, never relabelled', async () => {
    await openSession();
    const entry = await register('Claim three');
    const se = await sessionEpoch();
    expect((await claim(entry, se, 0)).outcome).toBe('created');
    await entryCommand(entry, 'check_in');
    expect(await sessionEpoch()).toBeGreaterThan(se);
    const stale = await claim(entry, se, 0, digest('c'));
    expect(stale).toEqual({
      outcome: 'stale',
      claim_id: null,
      claimed_digest: null,
    });
    // Even the identical original claim is stale once the epoch moved.
    expect((await claim(entry, se, 0)).outcome).toBe('stale');
    expect(await claimCount()).toBe(1);
    // A fresh snapshot claims successfully.
    expect((await claim(entry, await sessionEpoch(), 0)).outcome).toBe(
      'created',
    );
  });

  it('is stale after a historical prior change from another session', async () => {
    await openSession();
    const first = await register('Claim four');
    const waiting = await register('Claim five');
    const se = await sessionEpoch();
    expect((await claim(waiting, se, 0)).outcome).toBe('created');
    await runToStart(first);
    const se2 = await sessionEpoch();
    await entryCommand(first, 'complete_consultation');
    expect(await priorEpoch()).toBe(1);
    expect(
      (await claim(waiting, await sessionEpoch(), 0, digest('d'))).outcome,
    ).toBe('stale');
    expect(
      (await claim(waiting, await sessionEpoch(), 1, digest('d'))).outcome,
    ).toBe('created');
    expect(se2).toBeGreaterThanOrEqual(se);
  });

  it('keys uniqueness on contract version and evaluation instant', async () => {
    await openSession();
    const entry = await register('Claim six');
    const se = await sessionEpoch();
    expect((await claim(entry, se, 0)).outcome).toBe('created');
    expect(
      (
        await claim(entry, se, 0, digest('a'), {
          version: 'eta-uncertainty/v2',
        })
      ).outcome,
    ).toBe('created');
    expect(
      (
        await claim(entry, se, 0, digest('a'), {
          at: '2026-09-20T09:31:00.000Z',
        })
      ).outcome,
    ).toBe('created');
    expect(await claimCount()).toBe(3);
  });

  it('refuses cross-tenant, wrong-session and unknown-entry tuples as stale', async () => {
    await openSession();
    const entry = await register('Claim seven');
    const se = await sessionEpoch();
    expect(
      (await claim(entry, se, 0, digest('a'), { clinic: ids.otherClinic }))
        .outcome,
    ).toBe('stale');
    expect(
      (await claim(entry, 0, 0, digest('a'), { session: ids.sibling })).outcome,
    ).toBe('stale');
    expect((await claim(randomUUID(), se, 0)).outcome).toBe('stale');
    expect(await claimCount()).toBe(0);
  });

  it('rejects malformed digest and contract version at the table', async () => {
    await openSession();
    const entry = await register('Claim eight');
    const se = await sessionEpoch();
    await expect(claim(entry, se, 0, 'not-a-digest')).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      claim(entry, se, 0, digest('a'), { version: 'V1' }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('makes claims immutable and refuses a direct stale insert', async () => {
    await openSession();
    const entry = await register('Claim nine');
    const se = await sessionEpoch();
    const made = await claim(entry, se, 0);
    await expect(
      pool.query(
        `UPDATE eta_publication_claims SET evidence_digest=$2 WHERE id=$1`,
        [made.claim_id, digest('z')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`DELETE FROM eta_publication_claims WHERE id=$1`, [
        made.claim_id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO eta_publication_claims(clinic_id,session_id,entry_id,session_epoch,prior_epoch,contract_version,evaluated_at,evidence_digest)
         VALUES($1,$2,$3,$4,0,$5,$6,$7)`,
        [ids.clinic, ids.session, entry, se + 5, V1, T0, digest('a')],
      ),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('converges concurrent identical retries on one row', async () => {
    await openSession();
    const entry = await register('Claim ten');
    const se = await sessionEpoch();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claim(entry, se, 0)),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'existing')).toHaveLength(5);
    expect(new Set(results.map((r) => r.claim_id)).size).toBe(1);
    expect(await claimCount()).toBe(1);
  });

  it('refuses a direct insert pairing an entry with another session', async () => {
    await openSession();
    const entry = await register('Claim twelve');
    const sibling = await pool.query<{ e: string }>(
      `SELECT eta_source_epoch::text AS e FROM consultation_sessions WHERE id=$1`,
      [ids.sibling],
    );
    await expect(
      pool.query(
        `INSERT INTO eta_publication_claims(clinic_id,session_id,entry_id,session_epoch,prior_epoch,contract_version,evaluated_at,evidence_digest)
         VALUES($1,$2,$3,$4,0,$5,$6,$7)`,
        [
          ids.clinic,
          ids.sibling,
          entry,
          sibling.rows[0]!.e,
          V1,
          T0,
          digest('a'),
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await claimCount()).toBe(0);
  });

  async function waitForBlockedWriter(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (Number(r.rows[0]!.n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('writer never blocked on the in-flight claim');
  }

  async function inFlightClaim(
    entry: string,
    sessionEpochValue: number,
    run: () => Promise<unknown>,
    direct = false,
  ): Promise<void> {
    const a = await pool.connect();
    let writer: Promise<unknown> | undefined;
    try {
      await a.query('BEGIN');
      if (direct) {
        await a.query(
          `INSERT INTO eta_publication_claims(clinic_id,session_id,entry_id,session_epoch,prior_epoch,contract_version,evaluated_at,evidence_digest)
           VALUES($1,$2,$3,$4,0,$5,$6,$7)`,
          [
            ids.clinic,
            ids.session,
            entry,
            sessionEpochValue,
            V1,
            T0,
            digest('a'),
          ],
        );
      } else {
        const r = await a.query<Outcome>(
          `SELECT * FROM claim_eta_publication($1,$2,$3,$4,0,$5,$6,$7)`,
          [
            ids.clinic,
            ids.session,
            entry,
            sessionEpochValue,
            V1,
            T0,
            digest('a'),
          ],
        );
        expect(r.rows[0]!.outcome).toBe('created');
      }
      let writerDone = false;
      writer = run().then(() => {
        writerDone = true;
      });
      await waitForBlockedWriter();
      expect(writerDone).toBe(false);
      await a.query('COMMIT');
    } catch (error) {
      await a.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      a.release();
    }
    await writer;
  }

  it('blocks a session source change until an in-flight claim commits, then reports stale', async () => {
    await openSession();
    const entry = await register('Claim eleven');
    const se = await sessionEpoch();
    await inFlightClaim(entry, se, () => entryCommand(entry, 'check_in'));
    expect((await claim(entry, se, 0)).outcome).toBe('stale');
    expect(await claimCount()).toBe(1);
  });

  it('blocks first prior-epoch creation until an in-flight epoch-0 claim commits', async () => {
    await openSession();
    const sample = await register('Claim thirteen');
    const waiting = await register('Claim fourteen');
    await runToStart(sample);
    const se = await sessionEpoch();
    expect(await priorEpoch()).toBe(0);
    await inFlightClaim(waiting, se, () =>
      entryCommand(sample, 'complete_consultation'),
    );
    expect(await priorEpoch()).toBe(1);
    expect(
      (await claim(waiting, await sessionEpoch(), 0, digest('e'))).outcome,
    ).toBe('stale');
  });

  it('also serializes a direct insert against concurrent source changes', async () => {
    await openSession();
    const entry = await register('Claim fifteen');
    const se = await sessionEpoch();
    await inFlightClaim(entry, se, () => entryCommand(entry, 'check_in'), true);
    expect(await claimCount()).toBe(1);
    expect((await claim(entry, se, 0, digest('a'))).outcome).toBe('stale');
  });
});
