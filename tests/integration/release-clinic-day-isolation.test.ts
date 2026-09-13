import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueConflictError, QueueService } from '@/modules/queue';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });

const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionistA: randomUUID(),
  receptionistB: randomUUID(),
  doctorUserA: randomUUID(),
  doctorUserB: randomUUID(),
  doctorA: randomUUID(),
  doctorB: randomUUID(),
  sessionA: randomUUID(),
  sessionB: randomUUID(),
};

const scopeA = { clinicId: ids.clinicA, actorUserId: ids.receptionistA };
const scopeB = { clinicId: ids.clinicB, actorUserId: ids.receptionistB };

beforeAll(migrate);

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);

  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'release-reception-a','Reception A'),
      ($2,'release-reception-b','Reception B'),
      ($3,'release-doctor-a','Doctor A'),
      ($4,'release-doctor-b','Doctor B')`,
    [
      ids.receptionistA,
      ids.receptionistB,
      ids.doctorUserA,
      ids.doctorUserB,
    ],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
      ($1,'release-clinic-a','Clinic A'),
      ($2,'release-clinic-b','Clinic B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
      ($1,$3,'receptionist'),
      ($2,$4,'receptionist'),
      ($1,$5,'doctor'),
      ($2,$6,'doctor')`,
    [
      ids.clinicA,
      ids.clinicB,
      ids.receptionistA,
      ids.receptionistB,
      ids.doctorUserA,
      ids.doctorUserB,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES
      ($1,$3,'Doctor A'),($2,$4,'Doctor B')`,
    [ids.doctorA, ids.doctorB, ids.doctorUserA, ids.doctorUserB],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES
      ($1,$3),($2,$4)`,
    [ids.clinicA, ids.clinicB, ids.doctorA, ids.doctorB],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES
      ($1,$3,$5,CURRENT_DATE,CURRENT_DATE+time '09:00',CURRENT_DATE+time '12:00','open'),
      ($2,$4,$6,CURRENT_DATE,CURRENT_DATE+time '09:00',CURRENT_DATE+time '12:00','open')`,
    [
      ids.sessionA,
      ids.sessionB,
      ids.clinicA,
      ids.clinicB,
      ids.doctorA,
      ids.doctorB,
    ],
  );
});

afterAll(() => pool.end());

function registrationInput(
  privateDisplayName: string,
  preferredLocale: 'ar' | 'fr',
  key: string,
) {
  return {
    privateDisplayName,
    preferredLocale,
    idempotencyKey: key,
    correlationId: `release-${key}`,
  };
}

async function progressToCompleted(
  scope: typeof scopeA,
  sessionId: string,
  entryId: string,
  keyPrefix: string,
) {
  const queue = new QueueService(pool);
  for (const command of [
    'check_in',
    'call',
    'start_consultation',
    'complete_consultation',
  ] as const) {
    await queue.command(scope, sessionId, entryId, {
      command,
      idempotencyKey: `${keyPrefix}-${command}`,
      correlationId: `${keyPrefix}-${command}`,
    });
  }
}

describe('WU46 two-clinic release acceptance isolation', () => {
  it(
    'progresses two real clinic queues independently and rejects cross-clinic mutation',
    async () => {
      const queue = new QueueService(pool);
      const registrationA = await queue.registerWalkIn(
        scopeA,
        ids.sessionA,
        registrationInput('Patient A', 'fr', 'clinic-a-register'),
      );
      const registrationB = await queue.registerWalkIn(
        scopeB,
        ids.sessionB,
        registrationInput('المريض ب', 'ar', 'clinic-b-register'),
      );

      expect(registrationA.entry.state).toBe('waiting');
      expect(registrationB.entry.state).toBe('waiting');
      expect(registrationA.patient.id).not.toBe(registrationB.patient.id);

      expect(await queue.listWaiting(scopeA, ids.sessionA)).toHaveLength(1);
      expect(await queue.listWaiting(scopeB, ids.sessionB)).toHaveLength(1);

      await expect(
        queue.command(scopeA, ids.sessionB, registrationB.entry.id, {
          command: 'check_in',
          idempotencyKey: 'clinic-a-cross-mutation',
          correlationId: 'clinic-a-cross-mutation',
        }),
      ).rejects.toBeInstanceOf(QueueConflictError);
      await expect(
        queue.command(scopeB, ids.sessionA, registrationA.entry.id, {
          command: 'check_in',
          idempotencyKey: 'clinic-b-cross-mutation',
          correlationId: 'clinic-b-cross-mutation',
        }),
      ).rejects.toBeInstanceOf(QueueConflictError);

      const beforeProgress = await pool.query<{
        clinic_id: string;
        state: string;
        count: string;
      }>(
        `SELECT clinic_id::text, state::text, count(*)::text count
         FROM queue_entries
        GROUP BY clinic_id, state
        ORDER BY clinic_id`,
      );
      expect(beforeProgress.rows).toEqual(
        expect.arrayContaining([
          { clinic_id: ids.clinicA, state: 'waiting', count: '1' },
          { clinic_id: ids.clinicB, state: 'waiting', count: '1' },
        ]),
      );

      await progressToCompleted(
        scopeA,
        ids.sessionA,
        registrationA.entry.id,
        'clinic-a',
      );
      await progressToCompleted(
        scopeB,
        ids.sessionB,
        registrationB.entry.id,
        'clinic-b',
      );

      const persisted = await pool.query<{
        clinic_id: string;
        completed_entries: string;
        patients: string;
      }>(
        `SELECT clinic.id::text clinic_id,
              count(DISTINCT entry.id)::text completed_entries,
              count(DISTINCT patient.id)::text patients
         FROM clinics clinic
         LEFT JOIN queue_entries entry
           ON entry.clinic_id=clinic.id AND entry.state='completed'
         LEFT JOIN patient_operational_records patient
           ON patient.clinic_id=clinic.id
        WHERE clinic.id IN ($1,$2)
        GROUP BY clinic.id
        ORDER BY clinic.id`,
        [ids.clinicA, ids.clinicB],
      );

      expect(persisted.rows).toEqual(
        expect.arrayContaining([
          { clinic_id: ids.clinicA, completed_entries: '1', patients: '1' },
          { clinic_id: ids.clinicB, completed_entries: '1', patients: '1' },
        ]),
      );

      const crossClinicReceipts = await pool.query<{ count: number }>(
        `SELECT count(*)::int count
         FROM queue_command_receipts
        WHERE idempotency_key IN ('clinic-a-cross-mutation','clinic-b-cross-mutation')`,
      );
      expect(crossClinicReceipts.rows[0]!.count).toBe(0);
    },
  );
});
