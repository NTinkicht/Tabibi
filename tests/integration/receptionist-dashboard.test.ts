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
  it('composes session, delay and deterministic service order without clinical/contact values', async () => {
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
    expect(snapshot.refreshAfterSeconds).toBe(30);
    expect(JSON.stringify(snapshot)).not.toContain('0555000000');
    expect(Object.keys(snapshot.entries[0]!)).not.toContain('diagnosis');
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
  });
});
