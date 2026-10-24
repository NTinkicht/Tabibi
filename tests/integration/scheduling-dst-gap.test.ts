import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { SchedulingService } from '@/modules/scheduling';

// TAB-P0-02 (#645): an occurrence whose local start or end wall time does not
// exist on its service date (DST spring-forward gap) is skipped and counted,
// instead of being stored at a shifted instant or failing the whole call on
// the session duration CHECK. Europe/Paris springs forward on 2026-03-29
// (02:00 -> 03:00 local) and falls back on 2026-10-25 (03:00 -> 02:00 local).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const ids = {
  paris: randomUUID(),
  algiers: randomUUID(),
  admin: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
};
const parisScope = { clinicId: ids.paris, actorUserId: ids.admin };
const algiersScope = { clinicId: ids.algiers, actorUserId: ids.admin };
const SUNDAY = 0;

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
       ($1, 'dst-gap-admin', 'Admin'), ($2, 'dst-gap-doctor', 'Doctor')`,
    [ids.admin, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name, timezone) VALUES
       ($1, 'dst-gap-paris', 'Paris', 'Europe/Paris'),
       ($2, 'dst-gap-algiers', 'Algiers', 'Africa/Algiers')`,
    [ids.paris, ids.algiers],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'clinic_admin'), ($2, $3, 'clinic_admin'),
       ($1, $4, 'doctor'), ($2, $4, 'doctor')`,
    [ids.paris, ids.algiers, ids.admin, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $3), ($2, $3)`,
    [ids.paris, ids.algiers, ids.doctor],
  );
});

afterAll(async () => pool.end());

async function template(
  scope: typeof parisScope,
  localStartTime: string,
  localEndTime: string,
  occurrenceIndex: number,
) {
  await new SchedulingService(pool).createTemplate(scope, {
    doctorId: ids.doctor,
    weekday: SUNDAY,
    localStartTime,
    localEndTime,
    occurrenceIndex,
  });
}

function generate(scope: typeof parisScope, startDate: string) {
  return new SchedulingService(pool).generateSessions(scope, {
    doctorId: ids.doctor,
    startDate,
    daysAhead: 21,
  });
}

async function sessions(clinicId: string) {
  const result = await pool.query<{
    service_date: string;
    template_occurrence: number;
    starts_at: string;
    ends_at: string;
  }>(
    `SELECT service_date::text, template_occurrence,
            to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS starts_at,
            to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS ends_at
       FROM consultation_sessions
      WHERE clinic_id = $1
      ORDER BY service_date, template_occurrence`,
    [clinicId],
  );
  return result.rows;
}

async function generationAudits(clinicId: string) {
  const result = await pool.query<{ metadata: unknown }>(
    `SELECT metadata FROM audit_events
      WHERE action = 'sessions.generated' AND clinic_id = $1 ORDER BY id`,
    [clinicId],
  );
  return result.rows.map((row) => row.metadata);
}

describe('session generation across a DST spring-forward gap', () => {
  it('skips an occurrence that starts inside the gap', async () => {
    await template(parisScope, '02:30', '04:00', 0);

    expect(await generate(parisScope, '2026-03-29')).toBe(2);
    expect(await sessions(ids.paris)).toEqual([
      {
        service_date: '2026-04-05',
        template_occurrence: 0,
        starts_at: '2026-04-05T00:30Z',
        ends_at: '2026-04-05T02:00Z',
      },
      {
        service_date: '2026-04-12',
        template_occurrence: 0,
        starts_at: '2026-04-12T00:30Z',
        ends_at: '2026-04-12T02:00Z',
      },
    ]);
    expect(await generationAudits(ids.paris)).toEqual([
      {
        startDate: '2026-03-29',
        daysAhead: 21,
        generated: 2,
        skippedCollisions: 0,
        skippedNonexistentLocalTime: 1,
      },
    ]);
  });

  it('skips gap occurrences, generates the other days and stays idempotent', async () => {
    // On 2026-03-29 the first range collapses to zero length (whole range in
    // the gap) and the second one ends inside the gap.
    await template(parisScope, '02:00', '03:00', 0);
    await template(parisScope, '00:30', '02:00', 1);

    // Sundays 2026-03-22, 2026-03-29 (gap) and 2026-04-05.
    expect(await generate(parisScope, '2026-03-22')).toBe(4);
    expect(await sessions(ids.paris)).toEqual([
      {
        service_date: '2026-03-22',
        template_occurrence: 0,
        starts_at: '2026-03-22T01:00Z',
        ends_at: '2026-03-22T02:00Z',
      },
      {
        service_date: '2026-03-22',
        template_occurrence: 1,
        starts_at: '2026-03-21T23:30Z',
        ends_at: '2026-03-22T01:00Z',
      },
      {
        service_date: '2026-04-05',
        template_occurrence: 0,
        starts_at: '2026-04-05T00:00Z',
        ends_at: '2026-04-05T01:00Z',
      },
      {
        service_date: '2026-04-05',
        template_occurrence: 1,
        starts_at: '2026-04-04T22:30Z',
        ends_at: '2026-04-05T00:00Z',
      },
    ]);

    expect(await generate(parisScope, '2026-03-22')).toBe(0);
    expect(await sessions(ids.paris)).toHaveLength(4);
    expect(await generationAudits(ids.paris)).toEqual([
      {
        startDate: '2026-03-22',
        daysAhead: 21,
        generated: 4,
        skippedCollisions: 0,
        skippedNonexistentLocalTime: 2,
      },
      {
        startDate: '2026-03-22',
        daysAhead: 21,
        generated: 0,
        skippedCollisions: 0,
        skippedNonexistentLocalTime: 2,
      },
    ]);
  });

  it('leaves a clinic without DST unaffected for the same local times', async () => {
    await template(algiersScope, '02:00', '03:00', 0);

    expect(await generate(algiersScope, '2026-03-22')).toBe(3);
    expect(await sessions(ids.algiers)).toEqual(
      ['2026-03-22', '2026-03-29', '2026-04-05'].map((day) => ({
        service_date: day,
        template_occurrence: 0,
        starts_at: `${day}T01:00Z`,
        ends_at: `${day}T02:00Z`,
      })),
    );
    expect(await generationAudits(ids.algiers)).toEqual([
      {
        startDate: '2026-03-22',
        daysAhead: 21,
        generated: 3,
        skippedCollisions: 0,
        skippedNonexistentLocalTime: 0,
      },
    ]);
  });

  it('still generates ambiguous fall-back local times deterministically', async () => {
    // 02:30 local occurs twice on 2026-10-25; the occurrence is generated once.
    await template(parisScope, '01:30', '04:00', 0);

    expect(await generate(parisScope, '2026-10-18')).toBe(3);
    const rows = await sessions(ids.paris);
    expect(rows.map((row) => row.service_date)).toEqual([
      '2026-10-18',
      '2026-10-25',
      '2026-11-01',
    ]);
    expect(rows[1]).toEqual({
      service_date: '2026-10-25',
      template_occurrence: 0,
      starts_at: '2026-10-24T23:30Z',
      ends_at: '2026-10-25T03:00Z',
    });
    expect(await generationAudits(ids.paris)).toEqual([
      {
        startDate: '2026-10-18',
        daysAhead: 21,
        generated: 3,
        skippedCollisions: 0,
        skippedNonexistentLocalTime: 0,
      },
    ]);
  });
});
