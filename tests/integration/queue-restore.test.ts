import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppointmentService } from '@/modules/appointment';
import { AppointmentRecoveryService } from '@/modules/appointment/recovery';
import { QueueConflictError, QueueService } from '@/modules/queue';
import { QueueRestoreService } from '@/modules/queue/restore';
import { migrate } from '../../scripts/db/lib';

// TAB-P0-07 (#810 slice 1): staff restore of walk-in/guest cancelled or
// no-show entries. Appointment-backed restore stays in appointment recovery.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctorRole: randomUUID(),
  outsider: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  closed: randomUUID(),
  patient: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
let seq = 0;
const key = () => `qr-${++seq}`;
const queue = () => new QueueService(pool);
const restoreSvc = () => new QueueRestoreService(pool);

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE appointment_recovery_receipts,
    appointment_lifecycle_receipts, appointment_booking_receipts, appointments,
    audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'qr-reception','Reception'),($2,'qr-doctor','Doctor'),
      ($3,'qr-doctor-role','Doctor Role'),($4,'qr-outsider','Outsider')`,
    [ids.receptionist, ids.doctorUser, ids.doctorRole, ids.outsider],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
      ($1,'qr-a','QR Clinic'),($2,'qr-b','QR Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
      ($1,$2,'receptionist'),($1,$3,'doctor'),($4,$5,'clinic_admin')`,
    [
      ids.clinic,
      ids.receptionist,
      ids.doctorRole,
      ids.otherClinic,
      ids.outsider,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr QR')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES
      ($1,$3,$4,'2026-09-18','2026-09-18 09:00Z','2026-09-18 12:00Z','open'),
      ($2,$3,$4,'2026-09-19','2026-09-19 09:00Z','2026-09-19 12:00Z','closed')`,
    [ids.session, ids.closed, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,private_display_name,preferred_locale)
      VALUES($1,$2,'QR Patient','fr')`,
    [ids.patient, ids.clinic],
  );
});
afterAll(async () => pool.end());

async function walkIn(name: string) {
  const item = await queue().registerWalkIn(scope, ids.session, {
    privateDisplayName: name,
    preferredLocale: 'ar',
    idempotencyKey: key(),
    correlationId: 'qr-register',
  });
  return item.entry.id;
}
async function cmd(
  entryId: string,
  command: Parameters<QueueService['command']>[3]['command'],
) {
  return queue().command(scope, ids.session, entryId, {
    command,
    reason: 'because',
    cancellationSource: command === 'cancel' ? 'clinic' : undefined,
    idempotencyKey: key(),
    correlationId: 'qr-cmd',
  });
}
function restore(entryId: string, checkIn = false, idempotencyKey = key()) {
  return restoreSvc().restore(scope, ids.session, entryId, {
    checkIn,
    reason: 'Marked by mistake',
    idempotencyKey,
    correlationId: 'qr-restore',
  });
}
const version = async () =>
  Number(
    (
      await pool.query<{ v: string }>(
        'SELECT queue_order_version v FROM consultation_sessions WHERE id=$1',
        [ids.session],
      )
    ).rows[0]!.v,
  );

describe('walk-in queue restore', () => {
  it('restores a cancelled entry to waiting, keeping identity and label', async () => {
    const id = await walkIn('A');
    const before = await pool.query(
      'SELECT registration_order, public_display_label FROM queue_entries WHERE id=$1',
      [id],
    );
    await cmd(id, 'cancel');
    const v0 = await version();
    const restored = await restore(id);
    expect(restored).toMatchObject({
      id,
      state: 'waiting',
      eligibilityOrder: null,
      priorityOrder: null,
    });
    const after = await pool.query(
      'SELECT registration_order, public_display_label FROM queue_entries WHERE id=$1',
      [id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await version()).toBe(v0 + 1);
  });

  it('restores a no-show and checks in at a fresh eligibility tail', async () => {
    const a = await walkIn('A');
    const b = await walkIn('B');
    await cmd(a, 'check_in');
    await cmd(a, 'no_show');
    await cmd(b, 'check_in');
    const restored = await restore(a, true);
    expect(restored.state).toBe('checked_in');
    expect(restored.eligibilityOrder).toBe(3);
    const bRow = await pool.query(
      'SELECT eligibility_order FROM queue_entries WHERE id=$1',
      [b],
    );
    expect(Number(bRow.rows[0].eligibility_order)).toBe(2);
  });

  it('never carries live priority back', async () => {
    const a = await walkIn('A');
    await pool.query('UPDATE queue_entries SET priority_order=1 WHERE id=$1', [
      a,
    ]);
    await cmd(a, 'cancel');
    const restored = await restore(a);
    expect(restored.priorityOrder).toBeNull();
  });

  it('refuses every non-terminal and completed source state', async () => {
    const a = await walkIn('A');
    await expect(restore(a)).rejects.toThrow(
      /Cannot restore queue entry in waiting/,
    );
    await cmd(a, 'check_in');
    await expect(restore(a)).rejects.toThrow(/checked_in/);
    await cmd(a, 'call');
    await expect(restore(a)).rejects.toThrow(/called/);
    await cmd(a, 'start_consultation');
    await expect(restore(a)).rejects.toThrow(/in_consultation/);
    await cmd(a, 'complete_consultation');
    await expect(restore(a)).rejects.toThrow(/completed/);
    const row = await pool.query(
      'SELECT state FROM queue_entries WHERE id=$1',
      [a],
    );
    expect(row.rows[0].state).toBe('completed');
  });

  it('is idempotent and rejects key reuse for a different request', async () => {
    const a = await walkIn('A');
    await cmd(a, 'cancel');
    const k = key();
    const first = await restore(a, false, k);
    const v = await version();
    const replay = await restore(a, false, k);
    expect(replay).toEqual(first);
    expect(await version()).toBe(v);
    await expect(restore(a, true, k)).rejects.toThrow(
      /different queue command/,
    );
    const audits = await pool.query(
      `SELECT count(*)::int n FROM audit_events WHERE action='queue_entry.restore'`,
    );
    expect(audits.rows[0].n).toBe(1);
  });

  it('serializes concurrent restores to exactly one success', async () => {
    const a = await walkIn('A');
    await cmd(a, 'cancel');
    const results = await Promise.allSettled([
      restore(a, true),
      restore(a, true),
      restore(a, false),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const row = await pool.query(
      'SELECT count(*) FILTER (WHERE eligibility_order IS NOT NULL)::int n FROM queue_entries WHERE session_id=$1',
      [ids.session],
    );
    expect(row.rows[0].n).toBeLessThanOrEqual(1);
  });

  it('preserves audit history and writes a restore audit event', async () => {
    const a = await walkIn('A');
    await cmd(a, 'cancel');
    await restore(a);
    const actions = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE entity_id=$1 `,
      [a],
    );
    const names = actions.rows.map((r) => r.action);
    expect(names).toContain('queue_entry.cancel');
    expect(names).toContain('queue_entry.restore');
    const meta = await pool.query(
      `SELECT metadata FROM audit_events WHERE action='queue_entry.restore'`,
    );
    expect(meta.rows[0].metadata).toMatchObject({
      from: 'cancelled',
      to: 'waiting',
      reason: 'Marked by mistake',
    });
  });

  it('requires a reason and a receptionist or clinic admin', async () => {
    const a = await walkIn('A');
    await cmd(a, 'cancel');
    await expect(
      restoreSvc().restore(scope, ids.session, a, {
        checkIn: false,
        reason: '   ',
        idempotencyKey: key(),
        correlationId: 'x',
      }),
    ).rejects.toThrow(/reason is required/);
    // Positive control above proves the role refusal below is for the role.
    for (const actor of [ids.doctorRole, ids.outsider]) {
      await expect(
        restoreSvc().restore(
          { clinicId: ids.clinic, actorUserId: actor },
          ids.session,
          a,
          {
            checkIn: false,
            reason: 'valid reason',
            idempotencyKey: key(),
            correlationId: 'x',
          },
        ),
      ).rejects.toThrow();
    }
    const row = await pool.query(
      'SELECT state FROM queue_entries WHERE id=$1',
      [a],
    );
    expect(row.rows[0].state).toBe('cancelled');
    expect((await restore(a)).state).toBe('waiting');
  });

  it('refuses a closed session and an entry from another session or clinic', async () => {
    const a = await walkIn('A');
    await cmd(a, 'cancel');
    await expect(
      restoreSvc().restore(scope, ids.closed, a, {
        checkIn: false,
        reason: 'valid reason',
        idempotencyKey: key(),
        correlationId: 'x',
      }),
    ).rejects.toThrow(/open or paused/);
    await expect(
      restoreSvc().restore(
        { clinicId: ids.otherClinic, actorUserId: ids.outsider },
        ids.session,
        a,
        {
          checkIn: false,
          reason: 'valid reason',
          idempotencyKey: key(),
          correlationId: 'x',
        },
      ),
    ).rejects.toThrow();
    const row = await pool.query(
      'SELECT state FROM queue_entries WHERE id=$1',
      [a],
    );
    expect(row.rows[0].state).toBe('cancelled');
  });

  it('refuses appointment-backed entries (they use appointment recovery)', async () => {
    const booking = await new AppointmentService(pool).bookForExistingPatient(
      scope,
      ids.session,
      {
        patientId: ids.patient,
        scheduledStartAt: new Date('2026-09-18T09:30:00Z'),
        scheduledEndAt: new Date('2026-09-18T09:45:00Z'),
        contactPreference: 'none',
        idempotencyKey: key(),
        correlationId: 'qr-book',
      },
    );
    const entryId = booking.entry.id;
    await cmd(entryId, 'cancel');
    await expect(restore(entryId)).rejects.toThrow(/appointment recovery/);
    const row = await pool.query(
      'SELECT state FROM queue_entries WHERE id=$1',
      [entryId],
    );
    expect(row.rows[0].state).toBe('cancelled');
  });

  it('refuses the cancelled source entry of a transferred appointment (no appointment references it any more)', async () => {
    const target = randomUUID();
    await pool.query(
      `INSERT INTO consultation_sessions
        (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
        VALUES($1,$2,$3,'2026-09-20','2026-09-20 09:00Z','2026-09-20 12:00Z','planned')`,
      [target, ids.clinic, ids.doctor],
    );
    const booking = await new AppointmentService(pool).bookForExistingPatient(
      scope,
      ids.session,
      {
        patientId: ids.patient,
        scheduledStartAt: new Date('2026-09-18T09:30:00Z'),
        scheduledEndAt: new Date('2026-09-18T09:45:00Z'),
        contactPreference: 'none',
        idempotencyKey: key(),
        correlationId: 'qr-book-transfer',
      },
    );
    await new AppointmentRecoveryService(pool).command(
      scope,
      ids.session,
      booking.appointment.id,
      {
        command: 'transfer',
        reason: 'Move to another day',
        targetSessionId: target,
        idempotencyKey: key(),
        correlationId: 'qr-transfer',
      },
    );
    const source = booking.entry.id;
    const state = await pool.query(
      'SELECT state FROM queue_entries WHERE id=$1',
      [source],
    );
    expect(state.rows[0].state).toBe('cancelled');
    const refs = await pool.query(
      'SELECT 1 FROM appointments WHERE queue_entry_id=$1',
      [source],
    );
    expect(refs.rowCount).toBe(0);
    await expect(restore(source)).rejects.toBeInstanceOf(QueueConflictError);
    const after = await pool.query(
      'SELECT state FROM queue_entries WHERE id=$1',
      [source],
    );
    expect(after.rows[0].state).toBe('cancelled');
  });
});
