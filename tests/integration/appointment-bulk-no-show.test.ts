import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppointmentConflictError,
  AppointmentService,
} from '@/modules/appointment';
import { AppointmentBulkNoShowService } from '@/modules/appointment/bulk-no-show';
import { AppointmentLifecycleService } from '@/modules/appointment/lifecycle';
import { QueueService } from '@/modules/queue';
import { ReceptionistDashboardService } from '@/modules/receptionist-dashboard';
import { SessionService } from '@/modules/session';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const clinicId = randomUUID();
const receptionist = randomUUID();
const doctorUser = randomUUID();
const doctorId = randomUUID();
const sessionId = randomUUID();
const scope = { clinicId, actorUserId: receptionist };
const service = new AppointmentBulkNoShowService(pool);

async function book(suffix: string) {
  const patientId = randomUUID();
  await pool.query(
    `INSERT INTO patient_operational_records
       (id,clinic_id,private_display_name,preferred_locale)
     VALUES($1,$2,$3,'fr')`,
    [patientId, clinicId, `WU171 patient ${suffix}`],
  );
  const now = Date.now();
  return new AppointmentService(pool).bookForExistingPatient(scope, sessionId, {
    patientId,
    scheduledStartAt: new Date(now - 30 * 60_000),
    scheduledEndAt: new Date(now + 15 * 60_000),
    contactPreference: 'none',
    idempotencyKey: `wu171-book-${suffix}`,
    correlationId: `wu171-book-${suffix}`,
  });
}

async function setScheduledMinutesAgo(appointmentId: string, minutes: number) {
  await pool.query(
    `UPDATE appointments
        SET scheduled_start_at=transaction_timestamp()-$2::integer * interval '1 minute',
            scheduled_end_at=transaction_timestamp()+interval '15 minutes'
      WHERE id=$1`,
    [appointmentId, minutes],
  );
}

async function paired(appointmentId: string) {
  const row = await pool.query<{ appointment: string; entry: string }>(
    `SELECT appointment.status::text appointment, entry.state::text entry
       FROM appointments appointment
       JOIN queue_entries entry ON entry.id=appointment.queue_entry_id
      WHERE appointment.id=$1`,
    [appointmentId],
  );
  return row.rows[0]!;
}

const bulkInput = (suffix: string, reason = 'Scheduled patient absent') => ({
  reason,
  idempotencyKey: `wu171-bulk-${suffix}`,
  correlationId: `wu171-bulk-${suffix}`,
});

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE appointment_bulk_no_show_receipts,
    appointment_lifecycle_receipts, appointment_booking_receipts,
    appointments, audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
       ($1,'wu171-reception','Reception'),($2,'wu171-doctor','Doctor')`,
    [receptionist, doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name,appointment_arrival_grace_minutes)
      VALUES($1,'wu171','WU171 Clinic',15)`,
    [clinicId],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
      VALUES($1,$2,'receptionist')`,
    [clinicId, receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name)
      VALUES($1,$2,'Dr WU171')`,
    [doctorId, doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES($1,$2,$3,now()::date,now()-interval '1 hour',
             now()+interval '2 hours','open')`,
    [sessionId, clinicId, doctorId],
  );
});
afterAll(async () => pool.end());

describe('WU171 explicit bulk absence, real PostgreSQL', () => {
  it('only resolves an appointment once its clinic-configured grace has expired', async () => {
    const booking = await book('grace');
    await setScheduledMinutesAgo(booking.appointment.id, 14);
    const early = await service.resolveWaiting(
      scope,
      sessionId,
      bulkInput('before'),
    );
    expect(early.resolvedAppointmentCount).toBe(0);
    expect(await paired(booking.appointment.id)).toEqual({
      appointment: 'confirmed',
      entry: 'waiting',
    });

    await setScheduledMinutesAgo(booking.appointment.id, 16);
    const late = await service.resolveWaiting(
      scope,
      sessionId,
      bulkInput('after'),
    );
    expect(late).toMatchObject({
      sessionId,
      scannedAppointmentCount: 1,
      resolvedAppointmentCount: 1,
      arrivalGraceMinutes: 15,
    });
    expect(await paired(booking.appointment.id)).toEqual({
      appointment: 'no_show',
      entry: 'no_show',
    });
  });

  it('leaves future appointments and contactless walk-ins waiting', async () => {
    const expired = await book('expired');
    const future = await book('future');
    await setScheduledMinutesAgo(expired.appointment.id, 30);
    await setScheduledMinutesAgo(future.appointment.id, 2);
    const walkInId = randomUUID();
    const entryId = randomUUID();
    await pool.query(
      `INSERT INTO patient_operational_records
         (id,clinic_id,private_display_name,preferred_locale)
       VALUES($1,$2,'Contactless walk-in','ar')`,
      [walkInId, clinicId],
    );
    await pool.query(
      `INSERT INTO queue_entries
         (id,clinic_id,session_id,patient_id,state,source,
          registration_order,public_display_label)
       VALUES($1,$2,$3,$4,'waiting','walk_in',3,'WU171-3')`,
      [entryId, clinicId, sessionId, walkInId],
    );
    const result = await service.resolveWaiting(
      scope,
      sessionId,
      bulkInput('mixed'),
    );
    expect(result.resolvedAppointmentCount).toBe(1);
    expect(await paired(expired.appointment.id)).toEqual({
      appointment: 'no_show',
      entry: 'no_show',
    });
    expect(await paired(future.appointment.id)).toEqual({
      appointment: 'confirmed',
      entry: 'waiting',
    });
    const guest = await pool.query<{ state: string }>(
      'SELECT state FROM queue_entries WHERE id=$1',
      [entryId],
    );
    expect(guest.rows[0]?.state).toBe('waiting');
  });

  it('is idempotent without duplicate audit and rejects changed-key payloads', async () => {
    const booking = await book('retry');
    await setScheduledMinutesAgo(booking.appointment.id, 30);
    const input = bulkInput('retry');
    const first = await service.resolveWaiting(scope, sessionId, input);
    const retry = await service.resolveWaiting(scope, sessionId, input);
    expect(retry).toEqual(first);
    expect(first.resolvedAppointmentCount).toBe(1);
    await expect(
      service.resolveWaiting(
        scope,
        sessionId,
        bulkInput('retry', 'Changed operational reason'),
      ),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
    const counts = await pool.query<{ receipts: string; audits: string }>(
      `SELECT
        (SELECT count(*)::text FROM appointment_bulk_no_show_receipts
          WHERE clinic_id=$1) receipts,
        (SELECT count(*)::text FROM audit_events
          WHERE action='appointment.no_show_bulk') audits`,
      [clinicId],
    );
    expect(counts.rows[0]).toEqual({ receipts: '1', audits: '1' });
  });

  it('never reclassifies cancelled or arrived appointments and leaves queue revision unchanged', async () => {
    const cancelled = await book('already-cancelled');
    const arrived = await book('already-arrived');
    await setScheduledMinutesAgo(cancelled.appointment.id, 30);
    await setScheduledMinutesAgo(arrived.appointment.id, 30);
    const lifecycle = new AppointmentLifecycleService(pool);
    await lifecycle.command(scope, sessionId, cancelled.appointment.id, {
      command: 'cancel',
      reason: 'Patient cancelled before arrival',
      idempotencyKey: 'wu171-cancel-before-bulk',
      correlationId: 'wu171-cancel-before-bulk',
    });
    await lifecycle.command(scope, sessionId, arrived.appointment.id, {
      command: 'check_in',
      idempotencyKey: 'wu171-checkin-before-bulk',
      correlationId: 'wu171-checkin-before-bulk',
    });
    const before = await pool.query<{ queue_order_version: string }>(
      'SELECT queue_order_version FROM consultation_sessions WHERE id=$1',
      [sessionId],
    );
    const result = await service.resolveWaiting(
      scope,
      sessionId,
      bulkInput('already-resolved'),
    );
    const after = await pool.query<{ queue_order_version: string }>(
      'SELECT queue_order_version FROM consultation_sessions WHERE id=$1',
      [sessionId],
    );
    expect(result.scannedAppointmentCount).toBe(0);
    expect(result.resolvedAppointmentCount).toBe(0);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await paired(cancelled.appointment.id)).toEqual({
      appointment: 'cancelled',
      entry: 'cancelled',
    });
    expect(await paired(arrived.appointment.id)).toEqual({
      appointment: 'checked_in',
      entry: 'checked_in',
    });
    const perEntryAudits = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM audit_events
        WHERE clinic_id=$1 AND action='appointment.no_show_bulk'`,
      [clinicId],
    );
    expect(perEntryAudits.rows[0]?.count).toBe('0');
  });

  it('bumps one queue revision and records privacy-minimal per-entry audit', async () => {
    const appointment = await book('revision');
    await setScheduledMinutesAgo(appointment.appointment.id, 30);
    const before = await pool.query<{ queue_order_version: string }>(
      'SELECT queue_order_version FROM consultation_sessions WHERE id=$1',
      [sessionId],
    );
    const response = await service.resolveWaiting(
      scope,
      sessionId,
      bulkInput('revision', 'Absent after documented grace'),
    );
    const after = await pool.query<{ queue_order_version: string }>(
      'SELECT queue_order_version FROM consultation_sessions WHERE id=$1',
      [sessionId],
    );
    expect(response.resolvedAppointmentCount).toBe(1);
    expect(Number(after.rows[0]!.queue_order_version)).toBe(
      Number(before.rows[0]!.queue_order_version) + 1,
    );
    const audit = await pool.query<{
      entity_id: string;
      reason: string;
      queue_entry_id: string;
    }>(
      `SELECT entity_id,
              metadata->>'reason' reason,
              metadata->>'queueEntryId' queue_entry_id
         FROM audit_events
        WHERE clinic_id=$1 AND action='appointment.no_show_bulk'`,
      [clinicId],
    );
    expect(audit.rows).toEqual([
      {
        entity_id: appointment.appointment.id,
        reason: 'Absent after documented grace',
        queue_entry_id: appointment.appointment.queueEntryId,
      },
    ]);
  });

  it('refreshes checked-in ETA revision after committed bulk waiting no-show without changing work ahead', async () => {
    const appointment = await book('wu174-revision');
    await setScheduledMinutesAgo(appointment.appointment.id, 30);
    const queue = new QueueService(pool);
    const checked = await queue.registerWalkIn(scope, sessionId, {
      privateDisplayName: 'WU174 synthetic present',
      preferredLocale: 'fr',
      idempotencyKey: 'wu174-registered',
      correlationId: 'wu174-registered',
    });
    await queue.command(scope, sessionId, checked.entry.id, {
      command: 'check_in',
      idempotencyKey: 'wu174-checked',
      correlationId: 'wu174-checked',
    });
    const dashboard = new ReceptionistDashboardService(pool);
    const before = await dashboard.getSnapshot(scope, sessionId);
    const prior = before.entries.find((item) => item.id === checked.entry.id)!;
    expect(prior.eta).toMatchObject({ patientsAhead: 0 });
    const receipt = await service.resolveWaiting(
      scope,
      sessionId,
      bulkInput('wu174-revision'),
    );
    expect(receipt.resolvedAppointmentCount).toBe(1);
    const after = await dashboard.getSnapshot(scope, sessionId);
    const current = after.entries.find((item) => item.id === checked.entry.id)!;
    expect(current.eta).toMatchObject({
      patientsAhead: prior.eta?.patientsAhead,
      minWaitMinutes: prior.eta?.minWaitMinutes,
      maxWaitMinutes: prior.eta?.maxWaitMinutes,
    });
    expect(after.session.queueOrderVersion).toBe(
      before.session.queueOrderVersion + 1,
    );
    expect(current.eta?.revision).not.toBe(prior.eta?.revision);
    const retry = await service.resolveWaiting(
      scope,
      sessionId,
      bulkInput('wu174-revision'),
    );
    expect(retry).toEqual(receipt);
    const stable = await dashboard.getSnapshot(scope, sessionId);
    expect(
      stable.entries.find((item) => item.id === checked.entry.id)?.eta
        ?.revision,
    ).toBe(current.eta?.revision);
  });


  it('WU175 completes a mixed clinic day only after explicit resolution, with committed ETA and audit evidence', async () => {
    const expired = await book('wu175-expired');
    const future = await book('wu175-future');
    await setScheduledMinutesAgo(expired.appointment.id, 30);
    await setScheduledMinutesAgo(future.appointment.id, 2);
    const queue = new QueueService(pool);
    const walkIn = await queue.registerWalkIn(scope, sessionId, {
      privateDisplayName: 'WU175 synthetic walk-in',
      preferredLocale: 'ar',
      idempotencyKey: 'wu175-register-walk-in',
      correlationId: 'wu175-register-walk-in',
    });
    await queue.command(scope, sessionId, walkIn.entry.id, {
      command: 'check_in',
      idempotencyKey: 'wu175-walk-in-arrived',
      correlationId: 'wu175-walk-in-arrived',
    });
    const sessions = new SessionService(pool);
    const dashboard = new ReceptionistDashboardService(pool);
    const before = await dashboard.getSnapshot(scope, sessionId);
    const beforeEta = before.entries.find(
      (item) => item.id === walkIn.entry.id,
    )?.eta;
    expect(beforeEta).toMatchObject({ patientsAhead: 0 });

    await expect(
      sessions.command(scope, sessionId, {
        command: 'close',
        idempotencyKey: 'wu175-close-with-active-entries',
        correlationId: 'wu175-close-with-active-entries',
      }),
    ).rejects.toThrow();

    const input = bulkInput(
      'wu175-day',
      'Verified expired appointment absence',
    );
    const receipt = await service.resolveWaiting(scope, sessionId, input);
    expect(receipt).toMatchObject({
      resolvedAppointmentCount: 1,
      arrivalGraceMinutes: 15,
    });
    expect(JSON.stringify(receipt)).not.toContain('WU175 synthetic');
    expect(await paired(expired.appointment.id)).toEqual({
      appointment: 'no_show',
      entry: 'no_show',
    });
    expect(await paired(future.appointment.id)).toEqual({
      appointment: 'confirmed',
      entry: 'waiting',
    });
    const live = await queue.listOperational(scope, sessionId);
    expect(
      live.entries.find((item) => item.id === walkIn.entry.id)?.state,
    ).toBe('checked_in');
    const after = await dashboard.getSnapshot(scope, sessionId);
    const afterEta = after.entries.find(
      (item) => item.id === walkIn.entry.id,
    )?.eta;
    expect(after.session.queueOrderVersion).toBe(
      before.session.queueOrderVersion + 1,
    );
    expect(afterEta).toMatchObject({
      patientsAhead: beforeEta?.patientsAhead,
      minWaitMinutes: beforeEta?.minWaitMinutes,
      maxWaitMinutes: beforeEta?.maxWaitMinutes,
    });
    expect(afterEta?.revision).not.toBe(beforeEta?.revision);

    expect(await service.resolveWaiting(scope, sessionId, input)).toEqual(
      receipt,
    );
    const stable = await dashboard.getSnapshot(scope, sessionId);
    expect(stable.session.queueOrderVersion).toBe(
      after.session.queueOrderVersion,
    );
    expect(
      stable.entries.find((item) => item.id === walkIn.entry.id)?.eta?.revision,
    ).toBe(afterEta?.revision);
    await expect(
      sessions.command(scope, sessionId, {
        command: 'close',
        idempotencyKey: 'wu175-close-still-blocked',
        correlationId: 'wu175-close-still-blocked',
      }),
    ).rejects.toThrow();

    await new AppointmentLifecycleService(pool).command(
      scope,
      sessionId,
      future.appointment.id,
      {
        command: 'cancel',
        reason: 'Future appointment cancelled explicitly',
        idempotencyKey: 'wu175-future-cancel',
        correlationId: 'wu175-future-cancel',
      },
    );
    await queue.command(scope, sessionId, walkIn.entry.id, {
      command: 'cancel',
      reason: 'Walk-in left before consultation',
      idempotencyKey: 'wu175-walk-in-cancel',
      correlationId: 'wu175-walk-in-cancel',
    });
    const closed = await sessions.command(scope, sessionId, {
      command: 'close',
      idempotencyKey: 'wu175-close-after-explicit-resolution',
      correlationId: 'wu175-close-after-explicit-resolution',
    });
    expect(closed.status).toBe('closed');
    expect(await paired(future.appointment.id)).toEqual({
      appointment: 'cancelled',
      entry: 'cancelled',
    });
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM audit_events
        WHERE clinic_id=$1 AND action='appointment.no_show_bulk'`,
      [clinicId],
    );
    expect(audit.rows[0]?.count).toBe('1');
  });

  it('serializes concurrent appointment check-in against bulk absence', async () => {
    const booking = await book('race');
    await setScheduledMinutesAgo(booking.appointment.id, 30);
    const lifecycle = new AppointmentLifecycleService(pool);
    // Start both commands after the same explicit barrier rather than
    // relying on incidental scheduling of two promises.
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const contend = async <T>(operation: () => Promise<T>): Promise<T> => {
      arrived++;
      if (arrived === 2) release();
      await barrier;
      return operation();
    };
    const results = await Promise.allSettled([
      contend(() =>
        service.resolveWaiting(scope, sessionId, bulkInput('race')),
      ),
      contend(() =>
        lifecycle.command(scope, sessionId, booking.appointment.id, {
          command: 'check_in',
          idempotencyKey: 'wu171-checkin-race',
          correlationId: 'wu171-checkin-race',
        }),
      ),
    ]);
    const state = await paired(booking.appointment.id);
    expect([
      { appointment: 'no_show', entry: 'no_show' },
      { appointment: 'checked_in', entry: 'checked_in' },
    ]).toContainEqual(state);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    const receipt = results[0];
    if (receipt.status === 'fulfilled') {
      expect(receipt.value.resolvedAppointmentCount).toBe(
        state.entry === 'no_show' ? 1 : 0,
      );
    }
  });

  it('serializes appointment cancellation against bulk absence with no split pair', async () => {
    const booking = await book('cancel-race');
    await setScheduledMinutesAgo(booking.appointment.id, 30);
    const lifecycle = new AppointmentLifecycleService(pool);
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const contend = async <T>(operation: () => Promise<T>): Promise<T> => {
      arrived++;
      if (arrived === 2) release();
      await barrier;
      return operation();
    };
    const outcomes = await Promise.allSettled([
      contend(() =>
        service.resolveWaiting(scope, sessionId, bulkInput('cancel-race')),
      ),
      contend(() =>
        lifecycle.command(scope, sessionId, booking.appointment.id, {
          command: 'cancel',
          reason: 'Patient cancelled independently',
          idempotencyKey: 'wu171-concurrent-cancel',
          correlationId: 'wu171-concurrent-cancel',
        }),
      ),
    ]);
    const state = await paired(booking.appointment.id);
    expect([
      { appointment: 'no_show', entry: 'no_show' },
      { appointment: 'cancelled', entry: 'cancelled' },
    ]).toContainEqual(state);
    expect(outcomes.some((result) => result.status === 'fulfilled')).toBe(true);
    if (outcomes[0]?.status === 'fulfilled')
      expect(outcomes[0].value.resolvedAppointmentCount).toBe(
        state.entry === 'no_show' ? 1 : 0,
      );
    if (outcomes[1]?.status === 'fulfilled')
      expect(state).toEqual({ appointment: 'cancelled', entry: 'cancelled' });
  });

  for (const status of ['planned', 'paused'] as const) {
    it(`explicitly resolves an expired booked arrival in ${status} session`, async () => {
      await pool.query(
        `UPDATE consultation_sessions SET status=$2 WHERE id=$1`,
        [sessionId, status],
      );
      const booking = await book(`status-${status}`);
      await setScheduledMinutesAgo(booking.appointment.id, 30);
      const receipt = await service.resolveWaiting(
        scope,
        sessionId,
        bulkInput(`status-${status}`),
      );
      expect(receipt.resolvedAppointmentCount).toBe(1);
      expect(await paired(booking.appointment.id)).toEqual({
        appointment: 'no_show',
        entry: 'no_show',
      });
    });
  }

  it('keeps normal close explicit and blocked until booked absence is resolved', async () => {
    const booking = await book('close');
    await setScheduledMinutesAgo(booking.appointment.id, 30);
    const sessions = new SessionService(pool);
    await expect(
      sessions.command(scope, sessionId, {
        command: 'close',
        idempotencyKey: 'wu171-close-too-early',
        correlationId: 'wu171-close-too-early',
      }),
    ).rejects.toThrow();
    const receipt = await service.resolveWaiting(
      scope,
      sessionId,
      bulkInput('before-close'),
    );
    expect(receipt.resolvedAppointmentCount).toBe(1);
    const closed = await sessions.command(scope, sessionId, {
      command: 'close',
      idempotencyKey: 'wu171-close-after-bulk',
      correlationId: 'wu171-close-after-bulk',
    });
    expect(closed.status).toBe('closed');
    expect(await paired(booking.appointment.id)).toEqual({
      appointment: 'no_show',
      entry: 'no_show',
    });
  });

  it('rejects wrong clinic, revoked role and terminal session', async () => {
    const booking = await book('denied');
    await setScheduledMinutesAgo(booking.appointment.id, 30);
    await expect(
      service.resolveWaiting(
        { clinicId: randomUUID(), actorUserId: receptionist },
        sessionId,
        bulkInput('tenant'),
      ),
    ).rejects.toThrow();
    await pool.query(
      `DELETE FROM clinic_memberships
        WHERE clinic_id=$1 AND user_id=$2`,
      [clinicId, receptionist],
    );
    await expect(
      service.resolveWaiting(scope, sessionId, bulkInput('revoked')),
    ).rejects.toThrow();
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role)
        VALUES($1,$2,'receptionist')`,
      [clinicId, receptionist],
    );
    await new SessionService(pool).command(scope, sessionId, {
      command: 'cancel',
      reason: 'Session cancelled',
      idempotencyKey: 'wu171-session-cancel',
      correlationId: 'wu171-session-cancel',
    });
    await expect(
      service.resolveWaiting(scope, sessionId, bulkInput('terminal')),
    ).rejects.toBeInstanceOf(AppointmentConflictError);
  });
});
