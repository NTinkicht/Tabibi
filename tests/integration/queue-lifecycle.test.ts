import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AuthorizationError } from '@/modules/identity';
import { QueueConflictError, QueueService } from '@/modules/queue';

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
    ($1,'life-reception','Reception'),($2,'life-other','Other'),($3,'life-doctor','Doctor')`,
    [ids.receptionist, ids.otherReceptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
    ($1,'life-clinic','Clinic'),($2,'life-other-clinic','Other')`,
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
      idempotencyKey: `register-life-${index}`,
      correlationId: `register-${index}`,
    });
    entries.push(item.entry.id);
  }
});
afterAll(() => pool.end());

function command(
  name: Parameters<QueueService['command']>[3]['command'],
  entry = entries[0]!,
  extra: Partial<Parameters<QueueService['command']>[3]> = {},
) {
  return new QueueService(pool).command(scope, ids.session, entry, {
    command: name,
    idempotencyKey: `${name}-${entry}`,
    correlationId: `corr-${name}`,
    ...extra,
  });
}

describe('receptionist queue lifecycle', () => {
  it('progresses check-in through completion and audits every transition', async () => {
    expect((await command('check_in')).state).toBe('checked_in');
    expect((await command('call')).state).toBe('called');
    expect((await command('start_consultation')).state).toBe('in_consultation');
    expect((await command('complete_consultation')).state).toBe('completed');
    const audits = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE entity_id=$1 AND action LIKE 'queue_entry.%' ORDER BY occurred_at`,
      [entries[0]],
    );
    expect(audits.rows).toHaveLength(4);
    expect(audits.rows[3]!.metadata).toMatchObject({
      from: 'in_consultation',
      to: 'completed',
      sessionId: ids.session,
    });
  });

  it('supports reasoned no-show and patient/clinic cancellation only from allowed states', async () => {
    await command('check_in');
    expect(
      (
        await command('no_show', entries[0], {
          reason: 'Absent after call window',
        })
      ).state,
    ).toBe('no_show');
    expect(
      (
        await command('cancel', entries[1], {
          reason: 'Patient requested',
          cancellationSource: 'patient',
        })
      ).state,
    ).toBe('cancelled');
    await expect(
      command('check_in', entries[0], { idempotencyKey: 'illegal-check-in' }),
    ).rejects.toBeInstanceOf(QueueConflictError);
  });

  it('returns exact retry, rejects conflicting reuse, and reauthorizes receipts', async () => {
    const first = await command('check_in');
    const retry = await command('check_in');
    expect(retry).toEqual(first);
    await expect(
      new QueueService(pool).command(scope, ids.session, entries[0]!, {
        command: 'cancel',
        reason: 'changed',
        cancellationSource: 'clinic',
        idempotencyKey: `check_in-${entries[0]}`,
        correlationId: 'different',
      }),
    ).rejects.toBeInstanceOf(QueueConflictError);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int count FROM audit_events WHERE entity_id=$1 AND action='queue_entry.check_in'`,
          [entries[0]],
        )
      ).rows[0].count,
    ).toBe(1);
    await pool.query(
      `DELETE FROM clinic_memberships WHERE clinic_id=$1 AND user_id=$2`,
      [ids.clinic, ids.receptionist],
    );
    await expect(command('check_in')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('enforces clinic isolation and one called/consulting patient under concurrent commands', async () => {
    await Promise.all(entries.map((entry) => command('check_in', entry)));
    const results = await Promise.allSettled(
      entries.map((entry) => command('call', entry)),
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(
      (
        await pool.query(
          `SELECT count(*)::int count FROM queue_entries WHERE session_id=$1 AND state='called'`,
          [ids.session],
        )
      ).rows[0].count,
    ).toBe(1);
    await expect(
      new QueueService(pool).command(
        { clinicId: ids.otherClinic, actorUserId: ids.otherReceptionist },
        ids.session,
        entries[0]!,
        { command: 'call', idempotencyKey: 'cross', correlationId: 'cross' },
      ),
    ).rejects.toBeInstanceOf(QueueConflictError);
  });
});
