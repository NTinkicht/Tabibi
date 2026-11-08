import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { closePool } from '@/platform/database/pool';
import { QueueService } from '@/modules/queue';
import { createStaffSessionToken } from '@/platform/http/staff-auth';
import { GET as dashboard } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/dashboard/route';
import { POST as entryCommand } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/commands/route';
import { POST as reorderRoute } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/reorder/route';

// Owner decisions #799 (option A) and #817: a doctor may call / start /
// complete / no-show, reorder and read the dashboard ONLY on sessions of their
// own doctor identity in the same clinic. Check-in, cancel and everything else stay
// receptionist/clinic_admin only; other doctors and other clinics are denied
// without any state change; retries are re-authorized.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const ORIGIN = 'http://localhost';
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionistA: randomUUID(),
  doctorA: randomUUID(),
  doctorA2: randomUUID(),
  doctorB: randomUUID(),
  profileA: randomUUID(),
  profileA2: randomUUID(),
  profileB: randomUUID(),
  session: randomUUID(),
  sessionA2: randomUUID(),
};
const subjects = {
  receptionistA: 'dq-reception-a',
  doctorA: 'dq-doctor-a',
  doctorA2: 'dq-doctor-a2',
  doctorB: 'dq-doctor-b',
};
const entries: string[] = [];
let otherSessionEntry = '';
let keySeq = 0;

async function cookieFor(subject: string): Promise<string> {
  const token = await createStaffSessionToken(
    subject,
    new Date(Date.now() + 60_000),
  );
  return `tabibi_staff_session=${token}`;
}

function request(
  url: string,
  method: string,
  cookie: string,
  body?: unknown,
  idempotencyKey = `dq-${++keySeq}`,
) {
  return new Request(url, {
    method,
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function command(
  subject: string,
  entryId: string,
  body: Record<string, unknown>,
  opts: { clinicId?: string; sessionId?: string; key?: string } = {},
): Promise<number> {
  const clinicId = opts.clinicId ?? ids.clinicA;
  const sessionId = opts.sessionId ?? ids.session;
  const response = await entryCommand(
    request(
      `${ORIGIN}/api/clinics/${clinicId}/sessions/${sessionId}/queue/${entryId}/commands`,
      'POST',
      await cookieFor(subject),
      body,
      opts.key,
    ),
    { params: Promise.resolve({ clinicId, sessionId, entryId }) },
  );
  return response.status;
}

async function reorderEntry(
  subject: string,
  entryId: string,
  body: Record<string, unknown>,
  opts: { clinicId?: string; sessionId?: string } = {},
): Promise<number> {
  const clinicId = opts.clinicId ?? ids.clinicA;
  const sessionId = opts.sessionId ?? ids.session;
  const response = await reorderRoute(
    request(
      `${ORIGIN}/api/clinics/${clinicId}/sessions/${sessionId}/queue/${entryId}/reorder`,
      'POST',
      await cookieFor(subject),
      body,
    ),
    { params: Promise.resolve({ clinicId, sessionId, entryId }) },
  );
  return response.status;
}

async function orderVersion(sessionId = ids.session): Promise<number> {
  const r = await pool.query<{ v: string }>(
    `SELECT queue_order_version AS v FROM consultation_sessions WHERE id = $1`,
    [sessionId],
  );
  return Number(r.rows[0]!.v);
}

async function priorityOf(entryId: string): Promise<string | null> {
  const r = await pool.query<{ p: string | null }>(
    `SELECT priority_order AS p FROM queue_entries WHERE id = $1`,
    [entryId],
  );
  return r.rows[0]!.p;
}

async function readDashboard(
  subject: string,
  opts: { clinicId?: string; sessionId?: string } = {},
): Promise<number> {
  const clinicId = opts.clinicId ?? ids.clinicA;
  const sessionId = opts.sessionId ?? ids.session;
  const response = await dashboard(
    request(
      `${ORIGIN}/api/clinics/${clinicId}/sessions/${sessionId}/dashboard`,
      'GET',
      await cookieFor(subject),
    ),
    { params: Promise.resolve({ clinicId, sessionId }) } as never,
  );
  return response.status;
}

async function stateOf(entryId: string): Promise<string> {
  const r = await pool.query<{ state: string }>(
    `SELECT state FROM queue_entries WHERE id = $1`,
    [entryId],
  );
  return r.rows[0]!.state;
}

async function allStates(): Promise<Record<string, string>> {
  const r = await pool.query<{ id: string; state: string }>(
    `SELECT id, state FROM queue_entries WHERE clinic_id = $1`,
    [ids.clinicA],
  );
  return Object.fromEntries(r.rows.map((row) => [row.id, row.state]));
}

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'doctor-queue-authorization-secret-at-least-32-chars';
  await migrate();
  await pool.query(
    `TRUNCATE audit_events, staff_sessions, queue_command_receipts,
       queue_registration_receipts, queue_entries, patient_operational_records,
       session_command_receipts, consultation_sessions, schedule_templates,
       clinic_memberships, doctor_clinics, doctor_profiles, clinics, users CASCADE`,
  );
  for (const [key, subject] of Object.entries(subjects)) {
    await pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [ids[key as keyof typeof subjects], subject],
    );
  }
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES ($1, 'dq-a', 'A'), ($2, 'dq-b', 'B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
       ($1, $3, 'receptionist'), ($1, $4, 'doctor'), ($1, $5, 'doctor'),
       ($2, $6, 'doctor')`,
    [
      ids.clinicA,
      ids.clinicB,
      ids.receptionistA,
      ids.doctorA,
      ids.doctorA2,
      ids.doctorB,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES
       ($1, $4, 'Dr A'), ($2, $5, 'Dr A2'), ($3, $6, 'Dr B')`,
    [
      ids.profileA,
      ids.profileA2,
      ids.profileB,
      ids.doctorA,
      ids.doctorA2,
      ids.doctorB,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $3), ($1, $4), ($2, $5)`,
    [ids.clinicA, ids.clinicB, ids.profileA, ids.profileA2, ids.profileB],
  );
  await pool.query(
    `INSERT INTO consultation_sessions (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $3, $4, CURRENT_DATE, CURRENT_DATE + time '09:00', CURRENT_DATE + time '12:00', 'open'),
            ($2, $3, $5, CURRENT_DATE, CURRENT_DATE + time '13:00', CURRENT_DATE + time '16:00', 'open')`,
    [ids.session, ids.sessionA2, ids.clinicA, ids.profileA, ids.profileA2],
  );
  const queue = new QueueService(pool);
  const reception = { clinicId: ids.clinicA, actorUserId: ids.receptionistA };
  for (let i = 0; i < 5; i++) {
    const item = await queue.registerWalkIn(reception, ids.session, {
      privateDisplayName: `Patient ${i}`,
      preferredLocale: 'fr',
      idempotencyKey: `dq-seed-${i}`,
      correlationId: `dq-seed-${i}`,
    });
    entries.push(item.entry.id);
  }
  // Entries 0..2 and 4 are checked in by reception; entry 3 stays waiting.
  for (const i of [0, 1, 2, 4])
    await queue.command(reception, ids.session, entries[i]!, {
      command: 'check_in',
      idempotencyKey: `dq-checkin-${i}`,
      correlationId: `dq-checkin-${i}`,
    });
  const other = await queue.registerWalkIn(reception, ids.sessionA2, {
    privateDisplayName: 'Other doctor patient',
    preferredLocale: 'ar',
    idempotencyKey: 'dq-seed-other',
    correlationId: 'dq-seed-other',
  });
  otherSessionEntry = other.entry.id;
  await queue.command(reception, ids.sessionA2, otherSessionEntry, {
    command: 'check_in',
    idempotencyKey: 'dq-checkin-other',
    correlationId: 'dq-checkin-other',
  });
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

describe('doctor queue authorization (owner decision #799)', () => {
  it('a non-owning doctor and other clinics are denied consultation commands and the dashboard, changing nothing', async () => {
    const before = await allStates();
    for (const cmd of ['call', 'start_consultation', 'complete_consultation'])
      expect(
        await command(subjects.doctorA2, entries[0]!, { command: cmd }),
        cmd,
      ).toBe(403);
    expect(
      await command(subjects.doctorA2, entries[0]!, {
        command: 'no_show',
        reason: 'left',
      }),
    ).toBe(403);
    // Another clinic's doctor, through clinic A's path and through its own.
    expect(
      await command(subjects.doctorB, entries[0]!, { command: 'call' }),
    ).toBe(403);
    expect(
      await command(
        subjects.doctorB,
        entries[0]!,
        { command: 'call' },
        { clinicId: ids.clinicB },
      ),
    ).toBe(403);
    // The owning doctor of session A cannot act on doctor A2's session.
    expect(
      await command(
        subjects.doctorA,
        otherSessionEntry,
        { command: 'call' },
        { sessionId: ids.sessionA2 },
      ),
    ).toBe(403);

    expect(await readDashboard(subjects.doctorA2)).toBe(403);
    expect(await readDashboard(subjects.doctorB)).toBe(403);
    expect(
      await readDashboard(subjects.doctorB, { clinicId: ids.clinicB }),
    ).toBe(403);
    expect(
      await readDashboard(subjects.doctorA, { sessionId: ids.sessionA2 }),
    ).toBe(403);
    // A session id that does not exist is denied to a doctor, not "not found".
    expect(
      await readDashboard(subjects.doctorA, { sessionId: randomUUID() }),
    ).toBe(403);
    // Reorder: other doctor, other clinic (both paths) and cross-session.
    const reorderBody = async () => ({
      targetPosition: 1,
      expectedVersion: await orderVersion(),
      reason: 'urgent',
    });
    expect(
      await reorderEntry(subjects.doctorA2, entries[4]!, await reorderBody()),
    ).toBe(403);
    expect(
      await reorderEntry(subjects.doctorB, entries[4]!, await reorderBody()),
    ).toBe(403);
    expect(
      await reorderEntry(subjects.doctorB, entries[4]!, await reorderBody(), {
        clinicId: ids.clinicB,
      }),
    ).toBe(403);
    expect(
      await reorderEntry(
        subjects.doctorA,
        otherSessionEntry,
        {
          targetPosition: 1,
          expectedVersion: await orderVersion(ids.sessionA2),
          reason: 'urgent',
        },
        { sessionId: ids.sessionA2 },
      ),
    ).toBe(403);
    expect(await priorityOf(entries[4]!)).toBeNull();
    expect(await priorityOf(otherSessionEntry)).toBeNull();
    expect(await allStates()).toEqual(before);
    expect(await stateOf(otherSessionEntry)).toBe('checked_in');
  });

  it('the owning doctor may not check in, cancel or reorder their own patients', async () => {
    const before = await allStates();
    expect(
      await command(subjects.doctorA, entries[3]!, { command: 'check_in' }),
    ).toBe(403);
    expect(
      await command(subjects.doctorA, entries[2]!, {
        command: 'cancel',
        reason: 'duplicate',
        cancellationSource: 'clinic',
      }),
    ).toBe(403);
    expect(await allStates()).toEqual(before);
  });

  it('the owning doctor reads the dashboard and runs call → start → complete, audited as the doctor', async () => {
    expect(await readDashboard(subjects.doctorA)).toBe(200);
    expect(
      await command(subjects.doctorA, entries[0]!, { command: 'call' }),
    ).toBe(200);
    expect(await stateOf(entries[0]!)).toBe('called');
    expect(
      await command(subjects.doctorA, entries[0]!, {
        command: 'start_consultation',
      }),
    ).toBe(200);
    expect(await stateOf(entries[0]!)).toBe('in_consultation');
    expect(
      await command(subjects.doctorA, entries[0]!, {
        command: 'complete_consultation',
      }),
    ).toBe(200);
    expect(await stateOf(entries[0]!)).toBe('completed');

    // The audit metadata contract is unchanged; the actor is the doctor user,
    // whose membership in this clinic is the doctor role.
    const audit = await pool.query<{
      action: string;
      actor_user_id: string;
      actor_role: string;
    }>(
      `SELECT audit.action, audit.actor_user_id, membership.role AS actor_role
         FROM audit_events audit
         JOIN clinic_memberships membership
           ON membership.clinic_id = audit.clinic_id
          AND membership.user_id = audit.actor_user_id
        WHERE audit.entity_type = 'queue_entry' AND audit.entity_id = $1
          AND audit.action IN ('queue_entry.call','queue_entry.start_consultation','queue_entry.complete_consultation')
        ORDER BY audit.id`,
      [entries[0]],
    );
    expect(audit.rows).toHaveLength(3);
    for (const row of audit.rows) {
      expect(row.actor_user_id).toBe(ids.doctorA);
      expect(row.actor_role).toBe('doctor');
    }
  });

  it('the owning doctor marks a called patient no-show only with a reason', async () => {
    expect(
      await command(subjects.doctorA, entries[1]!, { command: 'call' }),
    ).toBe(200);
    expect(
      await command(subjects.doctorA, entries[1]!, { command: 'no_show' }),
    ).toBe(400);
    expect(await stateOf(entries[1]!)).toBe('called');
    expect(
      await command(subjects.doctorA, entries[1]!, {
        command: 'no_show',
        reason: 'called twice, not present',
      }),
    ).toBe(200);
    expect(await stateOf(entries[1]!)).toBe('no_show');
  });

  it('the owning doctor replaces the next patient by another one through reorder (reason required)', async () => {
    // Entry 2 is next by arrival; the doctor wants entry 4 first.
    expect(
      await reorderEntry(subjects.doctorA, entries[4]!, {
        targetPosition: 1,
        expectedVersion: await orderVersion(),
      }),
    ).toBe(400);
    expect(await priorityOf(entries[4]!)).toBeNull();
    expect(
      await reorderEntry(subjects.doctorA, entries[4]!, {
        targetPosition: 1,
        expectedVersion: await orderVersion(),
        reason: 'clinical urgency',
      }),
    ).toBe(200);
    expect(await priorityOf(entries[4]!)).not.toBeNull();
    // `call` still only takes the committed next entry.
    expect(
      await command(subjects.doctorA, entries[2]!, { command: 'call' }),
    ).toBe(409);
    expect(await stateOf(entries[2]!)).toBe('checked_in');
    for (const cmd of ['call', 'start_consultation', 'complete_consultation'])
      expect(
        await command(subjects.doctorA, entries[4]!, { command: cmd }),
        cmd,
      ).toBe(200);
    expect(await stateOf(entries[4]!)).toBe('completed');

    const audit = await pool.query<{ actor_user_id: string }>(
      `SELECT actor_user_id FROM audit_events
        WHERE entity_type = 'queue_entry' AND entity_id = $1
          AND action LIKE '%reorder%'`,
      [entries[4]],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const row of audit.rows) expect(row.actor_user_id).toBe(ids.doctorA);
  });

  it('a doctor retry is re-authorized: the receipt cannot be replayed after losing the membership', async () => {
    const key = 'dq-retry-call';
    expect(
      await command(
        subjects.doctorA,
        entries[2]!,
        { command: 'call' },
        { key },
      ),
    ).toBe(200);
    expect(await stateOf(entries[2]!)).toBe('called');
    // Same key, same body: an idempotent replay while still authorized.
    expect(
      await command(
        subjects.doctorA,
        entries[2]!,
        { command: 'call' },
        { key },
      ),
    ).toBe(200);
    await pool.query(
      `DELETE FROM clinic_memberships WHERE clinic_id = $1 AND user_id = $2`,
      [ids.clinicA, ids.doctorA],
    );
    expect(
      await command(
        subjects.doctorA,
        entries[2]!,
        { command: 'call' },
        { key },
      ),
    ).toBe(403);
    expect(await readDashboard(subjects.doctorA)).toBe(403);
  });
});
