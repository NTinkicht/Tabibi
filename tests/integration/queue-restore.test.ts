import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { AppointmentService } from '@/modules/appointment';
import { AppointmentRecoveryService } from '@/modules/appointment/recovery';
import { AuthorizationError } from '@/modules/identity';
import {
  QueueConflictError,
  QueueService,
  QueueValidationError,
} from '@/modules/queue';

// G-01 / #810 slice 1: staff restore of a mistaken no_show or cancelled
// walk-in entry. Appointment-linked entries keep using the appointment route.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
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
let seq = 0;

beforeAll(migrate);
beforeEach(async () => {
  seq = 0;
  await pool.query(`TRUNCATE audit_events, queue_command_receipts,
    queue_registration_receipts, appointments, queue_entries,
    patient_operational_records, session_command_receipts,
    consultation_sessions, schedule_templates, doctor_clinics, doctor_profiles,
    clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'rest-reception','Reception'),($2,'rest-other','Other'),($3,'rest-doctor','Doctor')`,
    [ids.receptionist, ids.otherReceptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
    ($1,'rest-clinic','Clinic'),($2,'rest-other-clinic','Other')`,
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
  for (let index = 0; index < 3; index++) {
    const item = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: `Patient ${index}`,
      preferredLocale: 'fr',
      idempotencyKey: `register-rest-${index}`,
      correlationId: `register-${index}`,
    });
    entries.push(item.entry.id);
  }
});
afterAll(() => pool.end());

function command(
  name: Parameters<QueueService['command']>[3]['command'],
  entry: string,
  extra: Partial<Parameters<QueueService['command']>[3]> = {},
) {
  return new QueueService(pool).command(scope, ids.session, entry, {
    command: name,
    idempotencyKey: `${name}-${entry}-${seq++}`,
    correlationId: `corr-${name}`,
    ...extra,
  });
}
function restore(
  entry: string,
  extra: Partial<Parameters<QueueService['restore']>[3]> = {},
  actor = scope,
  session = ids.session,
) {
  return new QueueService(pool).restore(actor, session, entry, {
    reason: 'mistaken tap',
    idempotencyKey: `restore-${entry}-${seq++}`,
    correlationId: 'corr-restore',
    ...extra,
  });
}
async function version(): Promise<number> {
  const r = await pool.query<{ v: string }>(
    'SELECT queue_order_version AS v FROM consultation_sessions WHERE id=$1',
    [ids.session],
  );
  return Number(r.rows[0]!.v);
}
async function stateOf(entry: string): Promise<string> {
  const r = await pool.query<{ state: string }>(
    'SELECT state FROM queue_entries WHERE id=$1',
    [entry],
  );
  return r.rows[0]!.state;
}

describe('walk-in queue entry restore', () => {
  it('restores a no_show entry to waiting, advances the version and audits from/to', async () => {
    const [a] = entries as [string];
    await command('check_in', a);
    await command('no_show', a, { reason: 'left' });
    const before = await version();
    const restored = await restore(a);
    expect(restored.state).toBe('waiting');
    expect(restored.priorityOrder).toBeNull();
    expect(await version()).toBe(before + 1);
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE entity_id=$1 AND action='queue_entry.restore'`,
      [a],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      from: 'no_show',
      to: 'waiting',
      reason: 'mistaken tap',
    });
    // The earlier terminal transition stays in the audit history.
    const history = await pool.query(
      `SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='queue_entry.no_show'`,
      [a],
    );
    expect(history.rowCount).toBe(1);
  });

  it('restores a cancelled entry straight to checked_in at the fresh tail', async () => {
    const [a, b] = entries as [string, string];
    await command('check_in', b);
    await command('cancel', a, {
      reason: 'wrong person',
      cancellationSource: 'clinic',
    });
    const restored = await restore(a, { checkIn: true });
    expect(restored.state).toBe('checked_in');
    const orders = await pool.query<{ id: string; eligibility_order: string }>(
      `SELECT id,eligibility_order FROM queue_entries WHERE id=ANY($1)`,
      [[a, b]],
    );
    const byId = Object.fromEntries(
      orders.rows.map((r) => [r.id, Number(r.eligibility_order)]),
    );
    expect(byId[a]).toBeGreaterThan(byId[b]!);
  });

  it('drops any previous priority on restore', async () => {
    const [a] = entries as [string];
    await pool.query(`UPDATE queue_entries SET priority_order=1 WHERE id=$1`, [
      a,
    ]);
    await command('cancel', a, { reason: 'x', cancellationSource: 'patient' });
    expect((await restore(a)).priorityOrder).toBeNull();
    const r = await pool.query<{ p: string | null }>(
      'SELECT priority_order AS p FROM queue_entries WHERE id=$1',
      [a],
    );
    expect(r.rows[0]!.p).toBeNull();
  });

  it('rejects every source state other than no_show and cancelled, changing nothing', async () => {
    const [w, ci, c] = entries as [string, string, string];
    await command('check_in', ci);
    await command('check_in', c);
    // Service order puts ci first; call it, then park c as checked_in.
    await command('call', ci);
    const expectRejected = async (entry: string, state: string) => {
      const v = await version();
      expect(await stateOf(entry)).toBe(state);
      await expect(restore(entry)).rejects.toBeInstanceOf(QueueConflictError);
      expect(await stateOf(entry)).toBe(state);
      expect(await version()).toBe(v);
    };
    await expectRejected(w, 'waiting');
    await expectRejected(c, 'checked_in');
    await expectRejected(ci, 'called');
    await command('start_consultation', ci);
    await expectRejected(ci, 'in_consultation');
    await command('complete_consultation', ci);
    await expectRejected(ci, 'completed');
  });

  it('refuses entries linked to an appointment, and still restores the unlinked control', async () => {
    const [linked, free] = entries as [string, string];
    await command('cancel', linked, {
      reason: 'x',
      cancellationSource: 'clinic',
    });
    await command('cancel', free, {
      reason: 'x',
      cancellationSource: 'clinic',
    });
    const row = await pool.query<{ patient_id: string }>(
      'SELECT patient_id FROM queue_entries WHERE id=$1',
      [linked],
    );
    await pool.query(
      `INSERT INTO appointments(id,clinic_id,doctor_id,session_id,patient_id,queue_entry_id,status,
         scheduled_start_at,scheduled_end_at,preferred_locale)
       VALUES($1,$2,$3,$4,$5,$6,'cancelled',now(),now()+interval '15 minutes','fr')`,
      [
        randomUUID(),
        ids.clinic,
        ids.doctor,
        ids.session,
        row.rows[0]!.patient_id,
        linked,
      ],
    );
    await expect(restore(linked)).rejects.toThrow(/appointment/);
    expect(await stateOf(linked)).toBe('cancelled');
    expect((await restore(free)).state).toBe('waiting');
  });

  it('replays an identical retry without a second change and rejects key reuse with a different body', async () => {
    const [a] = entries as [string];
    await command('cancel', a, { reason: 'x', cancellationSource: 'clinic' });
    const input = {
      reason: 'mistaken tap',
      idempotencyKey: 'restore-fixed-key',
      correlationId: 'c',
    };
    const first = await restore(a, input);
    const v = await version();
    const second = await restore(a, input);
    expect(second).toEqual(first);
    expect(await version()).toBe(v);
    const audits = await pool.query(
      `SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='queue_entry.restore'`,
      [a],
    );
    expect(audits.rowCount).toBe(1);
    await expect(
      restore(a, { ...input, checkIn: true }),
    ).rejects.toBeInstanceOf(QueueConflictError);
  });

  it('serialises concurrent restores so exactly one applies', async () => {
    const [a] = entries as [string];
    await command('cancel', a, { reason: 'x', cancellationSource: 'clinic' });
    const results = await Promise.allSettled([restore(a), restore(a)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await stateOf(a)).toBe('waiting');
  });

  it('requires a reason and a receptionist or clinic admin of the same clinic', async () => {
    const [a] = entries as [string];
    await command('cancel', a, { reason: 'x', cancellationSource: 'clinic' });
    await expect(restore(a, { reason: '  ' })).rejects.toBeInstanceOf(
      QueueValidationError,
    );
    await expect(
      restore(a, {}, { clinicId: ids.clinic, actorUserId: ids.doctorUser }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      restore(
        a,
        {},
        { clinicId: ids.clinic, actorUserId: ids.otherReceptionist },
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await stateOf(a)).toBe('cancelled');
    expect((await restore(a)).state).toBe('waiting');
  });

  it('refuses a restore once the session is closed', async () => {
    const [a] = entries as [string];
    await command('cancel', a, { reason: 'x', cancellationSource: 'clinic' });
    for (const other of entries.slice(1))
      await command('cancel', other, {
        reason: 'x',
        cancellationSource: 'clinic',
      });
    await pool.query(
      `UPDATE consultation_sessions SET status='closed' WHERE id=$1`,
      [ids.session],
    );
    await expect(restore(a)).rejects.toBeInstanceOf(QueueConflictError);
    expect(await stateOf(a)).toBe('cancelled');
  });

  it('refuses the cancelled source entry of a transferred appointment, which no appointment references any more', async () => {
    const target = randomUUID();
    await pool.query(
      `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
       VALUES($1,$2,$3,CURRENT_DATE+1,CURRENT_DATE+1+time '09:00',CURRENT_DATE+1+time '12:00','planned')`,
      [target, ids.clinic, ids.doctor],
    );
    const patient = await pool.query<{ patient_id: string }>(
      'SELECT patient_id FROM queue_entries WHERE id=$1',
      [entries[0]],
    );
    const window = await pool.query<{ s: Date }>(
      'SELECT starts_at AS s FROM consultation_sessions WHERE id=$1',
      [ids.session],
    );
    const booking = await new AppointmentService(pool).bookForExistingPatient(
      scope,
      ids.session,
      {
        patientId: patient.rows[0]!.patient_id,
        scheduledStartAt: new Date(window.rows[0]!.s.getTime() + 3_600_000),
        scheduledEndAt: new Date(window.rows[0]!.s.getTime() + 4_500_000),
        contactPreference: 'none',
        idempotencyKey: 'rest-book',
        correlationId: 'rest-book',
      },
    );
    await new AppointmentRecoveryService(pool).command(
      scope,
      ids.session,
      booking.appointment.id,
      {
        command: 'transfer',
        reason: 'move',
        targetSessionId: target,
        idempotencyKey: 'rest-transfer',
        correlationId: 'rest-transfer',
      },
    );
    const source = booking.entry.id;
    expect(await stateOf(source)).toBe('cancelled');
    const refs = await pool.query(
      'SELECT 1 FROM appointments WHERE queue_entry_id=$1',
      [source],
    );
    expect(refs.rowCount).toBe(0);
    await expect(restore(source)).rejects.toBeInstanceOf(QueueConflictError);
    expect(await stateOf(source)).toBe('cancelled');
  });
});
