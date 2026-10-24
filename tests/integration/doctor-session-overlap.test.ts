import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { SchedulingService } from '@/modules/scheduling';
import { SessionConflictError, SessionService } from '@/modules/session';

// TAB-P0-02 (#640): one doctor never has two overlapping non-cancelled
// sessions in one clinic, whether they come from manual creation, template
// generation or a concurrent mix of both. Clinics use Africa/Algiers (UTC+1).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  admin: randomUUID(),
  otherAdmin: randomUUID(),
  receptionist: randomUUID(),
  otherReceptionist: randomUUID(),
  doctorUser: randomUUID(),
  otherDoctorUser: randomUUID(),
  doctor: randomUUID(),
  otherDoctor: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.admin };
const desk = { clinicId: ids.clinic, actorUserId: ids.receptionist };
const otherDesk = {
  clinicId: ids.otherClinic,
  actorUserId: ids.otherReceptionist,
};
const MONDAY = '2026-09-07';
const TUESDAY = '2026-09-08';

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, clinic_closures, session_command_receipts,
    consultation_sessions,
    schedule_templates, doctor_clinics, doctor_profiles, clinic_memberships,
    clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
       ($1, 'overlap-admin', 'Admin'), ($2, 'overlap-other-admin', 'Other Admin'),
       ($3, 'overlap-receptionist', 'Receptionist'),
       ($4, 'overlap-other-receptionist', 'Other Receptionist'),
       ($5, 'overlap-doctor', 'Doctor'), ($6, 'overlap-other-doctor', 'Other Doctor')`,
    [
      ids.admin,
      ids.otherAdmin,
      ids.receptionist,
      ids.otherReceptionist,
      ids.doctorUser,
      ids.otherDoctorUser,
    ],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
       ($1, 'overlap-clinic', 'Clinic'), ($2, 'overlap-other-clinic', 'Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($1, $4, 'receptionist'),
       ($2, $5, 'clinic_admin'), ($2, $6, 'receptionist')`,
    [
      ids.clinic,
      ids.otherClinic,
      ids.admin,
      ids.receptionist,
      ids.otherAdmin,
      ids.otherReceptionist,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
       ($1, $2, 'Doctor'), ($3, $4, 'Other Doctor')`,
    [ids.doctor, ids.doctorUser, ids.otherDoctor, ids.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES
       ($1, $3), ($2, $3), ($1, $4)`,
    [ids.clinic, ids.otherClinic, ids.doctor, ids.otherDoctor],
  );
});

afterAll(async () => pool.end());

let keySequence = 0;
// Local Africa/Algiers hours on serviceDate (UTC+1, no DST).
function manual(
  serviceDate: string,
  startHour: number,
  endHour: number,
  options: { doctorId?: string; at?: typeof desk; endDate?: string } = {},
) {
  const utc = (date: string, hour: number) =>
    new Date(Date.UTC(...ymd(date), hour - 1));
  keySequence += 1;
  return new SessionService(pool).createManual(options.at ?? desk, {
    doctorId: options.doctorId ?? ids.doctor,
    serviceDate,
    startsAt: utc(serviceDate, startHour),
    endsAt: utc(options.endDate ?? serviceDate, endHour),
    idempotencyKey: `overlap-${keySequence}`,
    correlationId: `request-overlap-${keySequence}`,
  });
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m - 1, d];
}

async function mondayTemplate(clinicScope = scope) {
  await new SchedulingService(pool).createTemplate(clinicScope, {
    doctorId: ids.doctor,
    weekday: 1,
    localStartTime: '09:00',
    localEndTime: '12:00',
    occurrenceIndex: 0,
  });
}

function generate(clinicScope = scope) {
  return new SchedulingService(pool).generateSessions(clinicScope, {
    doctorId: ids.doctor,
    startDate: MONDAY,
    daysAhead: 14,
  });
}

async function sessions(clinicId = ids.clinic) {
  const result = await pool.query<{
    doctor_id: string;
    template: boolean;
    starts_at: Date;
    ends_at: Date;
  }>(
    `SELECT doctor_id, template_id IS NOT NULL AS template, starts_at, ends_at
       FROM consultation_sessions
      WHERE clinic_id = $1 AND status <> 'cancelled'
      ORDER BY starts_at, doctor_id`,
    [clinicId],
  );
  return result.rows.map((row) => ({
    doctorId: row.doctor_id,
    template: row.template,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
  }));
}

async function overlappingPairs(): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM consultation_sessions a JOIN consultation_sessions b
         ON a.clinic_id = b.clinic_id AND a.doctor_id = b.doctor_id AND a.id < b.id
      WHERE a.status <> 'cancelled' AND b.status <> 'cancelled'
        AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at`,
  );
  return result.rows[0]!.n;
}

async function writeCounts() {
  const result = await pool.query<{ audits: number; receipts: number }>(
    `SELECT (SELECT count(*) FROM audit_events)::int AS audits,
            (SELECT count(*) FROM session_command_receipts)::int AS receipts`,
  );
  return result.rows[0]!;
}

describe('doctor session overlap within one clinic', () => {
  it('rejects an overlapping manual session and writes nothing', async () => {
    await manual(MONDAY, 9, 12);
    const before = { sessions: await sessions(), writes: await writeCounts() };

    for (const [start, end] of [
      [10, 11],
      [8, 10],
      [11, 13],
      [8, 13],
      [9, 12],
    ] as const) {
      await expect(manual(MONDAY, start, end)).rejects.toBeInstanceOf(
        SessionConflictError,
      );
    }
    expect({ sessions: await sessions(), writes: await writeCounts() }).toEqual(
      before,
    );
  });

  it('allows adjacent sessions, other doctors, other clinics and cancelled slots', async () => {
    await manual(MONDAY, 9, 12);
    await manual(MONDAY, 12, 14);
    await manual(MONDAY, 7, 9);
    await manual(MONDAY, 9, 12, { doctorId: ids.otherDoctor });
    await manual(MONDAY, 9, 12, { at: otherDesk });
    expect(await sessions()).toHaveLength(4);
    expect(await sessions(ids.otherClinic)).toHaveLength(1);

    await pool.query(
      `UPDATE consultation_sessions SET status = 'cancelled'
        WHERE clinic_id = $1 AND doctor_id = $2
          AND starts_at = '2026-09-07T08:00:00Z'`,
      [ids.clinic, ids.doctor],
    );
    await manual(MONDAY, 10, 11);
    expect(await overlappingPairs()).toBe(0);
  });

  it('rejects an overlap with a session that spans midnight from the previous day', async () => {
    // Monday 22:00 to Tuesday 02:00 local.
    await manual(MONDAY, 22, 2, { endDate: TUESDAY });
    await expect(manual(TUESDAY, 1, 3)).rejects.toBeInstanceOf(
      SessionConflictError,
    );
    await manual(TUESDAY, 2, 3);
    expect(await overlappingPairs()).toBe(0);
  });

  it('rejects a manual session over an already generated session', async () => {
    await mondayTemplate();
    expect(await generate()).toBe(2);
    await expect(manual(MONDAY, 11, 13)).rejects.toBeInstanceOf(
      SessionConflictError,
    );
    await manual(MONDAY, 12, 13);
    expect(await overlappingPairs()).toBe(0);
  });

  it('skips only the generated occurrence that would overlap a manual session and audits it', async () => {
    await mondayTemplate();
    await mondayTemplate({ clinicId: ids.otherClinic, actorUserId: ids.otherAdmin });
    await manual(MONDAY, 10, 11);

    expect(await generate()).toBe(1);
    expect(await sessions()).toEqual([
      {
        doctorId: ids.doctor,
        template: false,
        startsAt: '2026-09-07T09:00:00.000Z',
        endsAt: '2026-09-07T10:00:00.000Z',
      },
      {
        doctorId: ids.doctor,
        template: true,
        startsAt: '2026-09-14T08:00:00.000Z',
        endsAt: '2026-09-14T11:00:00.000Z',
      },
    ]);
    // Another clinic's generation never depends on this clinic's sessions.
    expect(
      await generate({ clinicId: ids.otherClinic, actorUserId: ids.otherAdmin }),
    ).toBe(2);

    // Regeneration is idempotent: the generated occurrence is not a collision
    // with itself, while the manual collision is still skipped and counted.
    expect(await generate()).toBe(0);
    const audits = await pool.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_events
        WHERE action = 'sessions.generated' AND clinic_id = $1 ORDER BY id`,
      [ids.clinic],
    );
    expect(audits.rows.map((row) => row.metadata)).toEqual([
      { startDate: MONDAY, daysAhead: 14, generated: 1, skippedCollisions: 1 },
      { startDate: MONDAY, daysAhead: 14, generated: 0, skippedCollisions: 1 },
    ]);
    expect(await overlappingPairs()).toBe(0);
  });

  it('generates the skipped day once the colliding manual session is cancelled', async () => {
    await mondayTemplate();
    await manual(MONDAY, 10, 11);
    expect(await generate()).toBe(1);
    await pool.query(
      `UPDATE consultation_sessions SET status = 'cancelled'
        WHERE clinic_id = $1 AND template_id IS NULL`,
      [ids.clinic],
    );
    expect(await generate()).toBe(1);
    expect(await sessions()).toHaveLength(2);
  });

  it('never lets two concurrent overlapping manual sessions both commit', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await pool.query('DELETE FROM session_command_receipts');
      await pool.query('DELETE FROM consultation_sessions');
      const results = await Promise.allSettled([
        manual(MONDAY, 9, 12),
        manual(MONDAY, 10, 13),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(SessionConflictError);
      expect(await sessions()).toHaveLength(1);
    }
  });

  it('never lets a concurrent manual session and generation overlap', async () => {
    await mondayTemplate();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await pool.query('DELETE FROM session_command_receipts');
      await pool.query('DELETE FROM consultation_sessions');
      const [created, generated] = await Promise.allSettled([
        manual(MONDAY, 10, 11),
        generate(),
      ]);
      expect(generated.status).toBe('fulfilled');
      const count = (generated as PromiseFulfilledResult<number>).value;
      if (created.status === 'fulfilled') expect(count).toBe(1);
      else {
        expect(created.reason).toBeInstanceOf(SessionConflictError);
        expect(count).toBe(2);
      }
      expect(await overlappingPairs()).toBe(0);
    }
  });
});
