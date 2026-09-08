import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/modules/identity';
import { QueueService } from '@/modules/queue';
import {
  ReceptionistDashboardService,
  ReceptionistDashboardNotFoundError,
} from '@/modules/receptionist-dashboard';
import { SessionService } from '@/modules/session';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  sessionA: randomUUID(),
  sessionB: randomUUID(),
};
const scope = { clinicId: ids.clinicA, actorUserId: ids.receptionist };

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'dashboard-reception','Reception'),($2,'dashboard-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
    ($1,'dashboard-a','A'),($2,'dashboard-b','B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist')`,
    [ids.clinicA, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr Dashboard')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$3),($2,$3)`,
    [ids.clinicA, ids.clinicB, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
    (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status,declared_delay_minutes,delay_version,delay_updated_at)
    VALUES ($1,$3,$5,'2026-09-08','2026-09-08 09:00Z','2026-09-08 12:00Z','open',20,1,now()),
           ($2,$4,$5,'2026-09-08','2026-09-08 13:00Z','2026-09-08 16:00Z','planned',NULL,0,NULL)`,
    [ids.sessionA, ids.sessionB, ids.clinicA, ids.clinicB, ids.doctor],
  );
});
afterAll(async () => pool.end());

describe('receptionist dashboard read model', () => {
  it('composes session, delay and deterministic fallback ETA without clinical/contact values', async () => {
    const queue = new QueueService(pool);
    const waiting = await queue.registerWalkIn(scope, ids.sessionA, {
      privateDisplayName: 'Waiting',
      contactPhone: '0555000000',
      preferredLocale: 'fr',
      idempotencyKey: 'reg-w',
      correlationId: 'reg-w',
    });
    const checked = await queue.registerWalkIn(scope, ids.sessionA, {
      privateDisplayName: 'Checked',
      preferredLocale: 'ar',
      idempotencyKey: 'reg-c',
      correlationId: 'reg-c',
    });
    await queue.command(scope, ids.sessionA, checked.entry.id, {
      command: 'check_in',
      idempotencyKey: 'check-c',
      correlationId: 'check-c',
    });

    const snapshot = await new ReceptionistDashboardService(pool).getSnapshot(
      scope,
      ids.sessionA,
    );
    expect(snapshot.session).toMatchObject({
      status: 'open',
      doctorDisplayName: 'Dr Dashboard',
      declaredDelayMinutes: 20,
      delayVersion: 1,
    });
    expect(snapshot.entries.map(({ id }) => id)).toEqual([
      checked.entry.id,
      waiting.entry.id,
    ]);
    expect(snapshot.entries[0]!.eta).toEqual({
      patientsAhead: 0,
      minWaitMinutes: 20,
      maxWaitMinutes: 20,
      estimatedConsultationMinutes: 15,
      estimateSource: 'fallback',
      observedSampleCount: 0,
    });
    expect(snapshot.entries[1]!.eta).toMatchObject({
      patientsAhead: 1,
      minWaitMinutes: 31,
      maxWaitMinutes: 43,
      estimatedConsultationMinutes: 15,
      estimateSource: 'fallback',
    });
    expect(snapshot.refreshAfterSeconds).toBe(30);
    expect(JSON.stringify(snapshot)).not.toContain('0555000000');
    expect(Object.keys(snapshot.entries[0]!)).not.toContain('diagnosis');
  });

  it('uses a clamped same-session observed median only after three completed samples and stays deterministic', async () => {
    const queue = new QueueService(pool);
    const durations = [8, 10, 12];
    for (let index = 0; index < durations.length; index++) {
      const registered = await queue.registerWalkIn(scope, ids.sessionA, {
        privateDisplayName: `Completed ${index}`,
        preferredLocale: 'fr',
        idempotencyKey: `sample-register-${index}`,
        correlationId: `sample-register-${index}`,
      });
      for (const [commandIndex, command] of [
        'check_in',
        'call',
        'start_consultation',
        'complete_consultation',
      ].entries()) {
        await queue.command(scope, ids.sessionA, registered.entry.id, {
          command: command as
            | 'check_in'
            | 'call'
            | 'start_consultation'
            | 'complete_consultation',
          idempotencyKey: `sample-${index}-${commandIndex}`,
          correlationId: `sample-${index}-${commandIndex}`,
        });
      }
      await pool.query(
        `UPDATE queue_entries
            SET completed_at = '2026-09-08 10:00Z'::timestamptz,
                in_consultation_started_at = '2026-09-08 10:00Z'::timestamptz - ($2 * interval '1 minute')
          WHERE id = $1`,
        [registered.entry.id, durations[index]],
      );
    }

    await queue.registerWalkIn(scope, ids.sessionA, {
      privateDisplayName: 'ETA first',
      preferredLocale: 'ar',
      idempotencyKey: 'eta-first',
      correlationId: 'eta-first',
    });
    const second = await queue.registerWalkIn(scope, ids.sessionA, {
      privateDisplayName: 'ETA second',
      preferredLocale: 'ar',
      idempotencyKey: 'eta-second',
      correlationId: 'eta-second',
    });

    const service = new ReceptionistDashboardService(pool);
    const firstRead = await service.getSnapshot(scope, ids.sessionA);
    const secondRead = await service.getSnapshot(scope, ids.sessionA);
    const secondEntry = firstRead.entries.find(
      (entry) => entry.id === second.entry.id,
    )!;
    expect(secondEntry.eta).toEqual({
      patientsAhead: 1,
      minWaitMinutes: 28,
      maxWaitMinutes: 35,
      estimatedConsultationMinutes: 10,
      estimateSource: 'observed_median',
      observedSampleCount: 3,
    });
    expect(secondRead.entries.map((entry) => entry.eta)).toEqual(
      firstRead.entries.map((entry) => entry.eta),
    );
  });

  it('excludes terminal entries from ETA output and future service-time consumption', async () => {
    const queue = new QueueService(pool);
    const completed = await queue.registerWalkIn(scope, ids.sessionA, {
      privateDisplayName: 'Completed terminal',
      preferredLocale: 'fr',
      idempotencyKey: 'terminal-completed-register',
      correlationId: 'terminal-completed-register',
    });
    for (const [index, command] of [
      'check_in',
      'call',
      'start_consultation',
      'complete_consultation',
    ].entries()) {
      await queue.command(scope, ids.sessionA, completed.entry.id, {
        command: command as
          | 'check_in'
          | 'call'
          | 'start_consultation'
          | 'complete_consultation',
        idempotencyKey: `terminal-completed-${index}`,
        correlationId: `terminal-completed-${index}`,
      });
    }
    const cancelled = await queue.registerWalkIn(scope, ids.sessionA, {
      privateDisplayName: 'Cancelled terminal',
      preferredLocale: 'ar',
      idempotencyKey: 'terminal-cancelled-register',
      correlationId: 'terminal-cancelled-register',
    });
    await queue.command(scope, ids.sessionA, cancelled.entry.id, {
      command: 'cancel',
      reason: 'patient request',
      cancellationSource: 'patient',
      idempotencyKey: 'terminal-cancelled-command',
      correlationId: 'terminal-cancelled-command',
    });
    const waiting = await queue.registerWalkIn(scope, ids.sessionA, {
      privateDisplayName: 'Still waiting',
      preferredLocale: 'fr',
      idempotencyKey: 'terminal-waiting-register',
      correlationId: 'terminal-waiting-register',
    });

    const snapshot = await new ReceptionistDashboardService(pool).getSnapshot(
      scope,
      ids.sessionA,
    );
    const completedEntry = snapshot.entries.find(
      (entry) => entry.id === completed.entry.id,
    )!;
    const cancelledEntry = snapshot.entries.find(
      (entry) => entry.id === cancelled.entry.id,
    )!;
    const waitingEntry = snapshot.entries.find(
      (entry) => entry.id === waiting.entry.id,
    )!;

    expect(completedEntry.state).toBe('completed');
    expect(completedEntry.eta).toBeNull();
    expect(cancelledEntry.state).toBe('cancelled');
    expect(cancelledEntry.eta).toBeNull();
    expect(waitingEntry.eta).toMatchObject({ patientsAhead: 0 });
  });

  it('denies wrong roles and treats a cross-clinic session as absent', async () => {
    await pool.query(
      `UPDATE clinic_memberships SET role='doctor' WHERE clinic_id=$1 AND user_id=$2`,
      [ids.clinicA, ids.receptionist],
    );
    const service = new ReceptionistDashboardService(pool);
    await expect(
      service.getSnapshot(scope, ids.sessionA),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await pool.query(
      `UPDATE clinic_memberships SET role='receptionist' WHERE clinic_id=$1 AND user_id=$2`,
      [ids.clinicA, ids.receptionist],
    );
    await expect(
      service.getSnapshot(scope, ids.sessionB),
    ).rejects.toBeInstanceOf(ReceptionistDashboardNotFoundError);
  });

  it('refreshes from newly committed queue and delay mutations', async () => {
    const service = new ReceptionistDashboardService(pool);
    const before = await service.getSnapshot(scope, ids.sessionA);
    await new QueueService(pool).registerWalkIn(scope, ids.sessionA, {
      privateDisplayName: 'Concurrent arrival',
      preferredLocale: 'ar',
      idempotencyKey: 'concurrent-register',
      correlationId: 'concurrent-register',
    });
    await new SessionService(pool).delay(scope, ids.sessionA, {
      command: 'update_delay',
      minutes: 35,
      expectedVersion: 1,
      idempotencyKey: 'dashboard-delay',
      correlationId: 'dashboard-delay',
    });
    const after = await service.getSnapshot(scope, ids.sessionA);
    expect(before.entries).toHaveLength(0);
    expect(after.entries).toHaveLength(1);
    expect(after.session).toMatchObject({
      declaredDelayMinutes: 35,
      delayVersion: 2,
    });
    expect(after.entries[0]!.eta).toMatchObject({
      minWaitMinutes: 35,
      maxWaitMinutes: 35,
    });
  });
});
