import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import { QueueService } from '@/modules/queue';
import vectors from '../fixtures/queue-mutation-audit-v1.vectors.json';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  receptionist: randomUUID(),
  otherReceptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
let entries: string[] = [];

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'qaud-reception','Reception'),($2,'qaud-other','Other'),($3,'qaud-doctor','Doctor')`,
    [ids.receptionist, ids.otherReceptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
    ($1,'qaud-clinic','Clinic'),($2,'qaud-other-clinic','Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
    ($1,$3,'receptionist'),($2,$4,'receptionist'),($1,$5,'doctor')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.receptionist,
      ids.otherReceptionist,
      ids.doctorUser,
    ],
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
    VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE+time '09:00',CURRENT_DATE+time '12:00','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  const queue = new QueueService(pool);
  entries = [];
  for (let index = 0; index < 2; index++) {
    const item = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: `Patient ${index}`,
      preferredLocale: 'ar',
      idempotencyKey: `register-qaud-${index}`,
      correlationId: `register-${index}`,
    });
    entries.push(item.entry.id);
  }
});
afterAll(() => pool.end());

type Command = Parameters<QueueService['command']>[3]['command'];
type Source = Parameters<QueueService['command']>[3]['cancellationSource'];

interface Vector {
  id: string;
  prelude: string[];
  command: string;
  reason: string | null;
  cancellationSource: string | null;
}

async function run(vector: Vector, entry: string, suffix: string) {
  const queue = new QueueService(pool);
  for (const step of vector.prelude)
    await queue.command(scope, ids.session, entry, {
      command: step as Command,
      idempotencyKey: `${suffix}-prelude-${step}`,
      correlationId: `${suffix}-prelude-${step}`,
    });
  return queue.command(scope, ids.session, entry, {
    command: vector.command as Command,
    idempotencyKey: `${suffix}-${vector.id}`,
    correlationId: `${suffix}-corr-${vector.id}`,
    ...(vector.reason === null ? {} : { reason: vector.reason }),
    ...(vector.cancellationSource === null
      ? {}
      : { cancellationSource: vector.cancellationSource as Source }),
  });
}

function mutationAudits(entry: string, action: string) {
  return pool.query<{ metadata: Record<string, unknown> }>(
    'SELECT metadata FROM audit_events WHERE entity_id=$1 AND action=$2',
    [entry, action],
  );
}

describe('executable queue mutation audit vectors (real PostgreSQL)', () => {
  it('pins the vector contract version', () => {
    expect(vectors.version).toBe('queue-mutation-audit/v1');
  });

  it.each(vectors.positive)(
    'positive vector $id emits exactly the specified audit evidence once',
    async (vector) => {
      const entry = entries[0]!;
      await run(vector, entry, 'pos');
      const audits = await mutationAudits(entry, vector.expected.action);
      expect(audits.rows).toHaveLength(1);
      const metadata = audits.rows[0]!.metadata;
      expect(Object.keys(metadata).sort()).toEqual(
        vector.expected.metadataKeys,
      );
      expect(metadata).toMatchObject({
        command: vector.command,
        outcome: 'applied',
        sessionId: ids.session,
        from: vector.expected.from,
        to: vector.expected.to,
        reason: vector.expected.reason,
        cancellationSource: vector.expected.cancellationSource,
        correlationId: `pos-corr-${vector.id}`,
        idempotencyKey: `pos-${vector.id}`,
      });
      if ('queueOrderingContractVersion' in vector.expected)
        expect(metadata.queueOrderingContractVersion).toBe(
          vector.expected.queueOrderingContractVersion,
        );
      else expect(metadata).not.toHaveProperty('queueOrderingContractVersion');

      const everything = await pool.query<{ metadata: unknown }>(
        'SELECT metadata FROM audit_events WHERE entity_id=$1',
        [entry],
      );
      const serialised = JSON.stringify(everything.rows);
      expect(serialised).not.toContain('Patient 0');
      expect(serialised).not.toMatch(/secret|token|password|phone|email/i);

      // Exact retry returns the stored receipt and writes no second audit row.
      await run({ ...vector, prelude: [] }, entry, 'pos');
      expect(
        (await mutationAudits(entry, vector.expected.action)).rows,
      ).toHaveLength(1);
    },
  );

  it.each(vectors.negative)(
    'negative vector $id is rejected and writes no audit evidence',
    async (vector) => {
      const entry = entries[0]!;
      for (const step of vector.prelude)
        await run(
          { ...vector, prelude: [], command: step, reason: null },
          entry,
          'neg-prelude',
        );
      const before = await pool.query(
        'SELECT 1 FROM audit_events WHERE entity_id=$1',
        [entry],
      );
      await expect(
        run({ ...vector, prelude: [] }, entry, 'neg'),
      ).rejects.toThrow();
      const after = await pool.query(
        'SELECT 1 FROM audit_events WHERE entity_id=$1',
        [entry],
      );
      expect(after.rows).toHaveLength(before.rows.length);
      const state = await pool.query<{ state: string }>(
        'SELECT state FROM queue_entries WHERE id=$1',
        [entry],
      );
      expect(['waiting', 'checked_in']).toContain(state.rows[0]!.state);
    },
  );
});
