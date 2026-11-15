import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GET } from '@/app/api/clinics/[clinicId]/notifications/dead-letters/route';
import { POST } from '@/app/api/clinics/[clinicId]/notifications/dead-letters/[intentId]/handled/route';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionist: randomUUID(),
};

const authSubject = 'wu40-reception';
const secret = 'wu40-api-test-session-secret-at-least-32-characters';

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = secret;
  await migrate();
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE notification_dead_letter_handlings, notification_outbox, clinic_memberships, clinics, users CASCADE',
  );
  await pool.query(
    `INSERT INTO users(id, auth_subject, display_name)
     VALUES ($1, $2, 'WU40 Reception')`,
    [ids.receptionist, authSubject],
  );
  await pool.query(
    `INSERT INTO clinics(id, tenant_key, name) VALUES
      ($1, 'wu40-a', 'WU40 A'),
      ($2, 'wu40-b', 'WU40 B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id, user_id, role)
     VALUES ($1, $2, 'receptionist')`,
    [ids.clinicA, ids.receptionist],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

async function authCookie() {
  return `tabibi_staff_session=${await createStaffSessionToken(
    authSubject,
    new Date(Date.now() + 60_000),
  )}`;
}

async function request(clinicId: string, query = '', authenticated = true) {
  return new Request(
    `http://localhost/api/clinics/${clinicId}/notifications/dead-letters${query}`,
    authenticated ? { headers: { cookie: await authCookie() } } : undefined,
  );
}

async function handle(
  clinicId: string,
  intentId: string,
  opts: { authenticated?: boolean; origin?: string | null } = {},
) {
  const headers: Record<string, string> = { host: 'localhost' };
  if (opts.authenticated !== false) headers.cookie = await authCookie();
  if (opts.origin !== null) headers.origin = opts.origin ?? 'http://localhost';
  return POST(
    new Request(
      `http://localhost/api/clinics/${clinicId}/notifications/dead-letters/${intentId}/handled`,
      { method: 'POST', headers },
    ),
    { params: Promise.resolve({ clinicId, intentId }) },
  );
}

async function listIds(clinicId: string): Promise<string[]> {
  const response = await GET(await request(clinicId), context(clinicId));
  const body = (await response.json()) as {
    deadLetters: Array<{ intentId: string }>;
  };
  return body.deadLetters.map((d) => d.intentId);
}

function context(clinicId: string) {
  return { params: Promise.resolve({ clinicId }) };
}

async function enqueue(
  clinicId: string,
  key: string,
  eventKey = 'turn_approaching',
) {
  return new NotificationOutboxRepository(pool).enqueue({
    clinicId,
    logicalTargetKey: `patient-private:${key}`,
    eventKey,
    intentVersion: 1,
    idempotencyKey: `private-idempotency:${key}`,
    payload: {
      renderedBody: `private rendered body ${key}`,
      contactPhone: '+971500000000',
    },
  });
}

async function deadLetter(
  clinicId: string,
  key: string,
  outcomeCode: string,
  outcomeAt: string,
) {
  const repository = new NotificationOutboxRepository(pool);
  const intent = await enqueue(clinicId, key);
  await pool.query(
    'UPDATE notification_outbox SET dispatch_max_attempts=1 WHERE id=$1',
    [intent.id],
  );
  const claim = await repository.claimPendingIntent({
    clinicId,
    intentId: intent.id,
    leaseMs: 60_000,
  });
  expect(claim).not.toBeNull();
  await repository.completeDispatchAttempt({
    clinicId,
    intentId: intent.id,
    claimToken: claim!.claimToken,
    outcome: 'failed',
    outcomeCode,
  });
  await pool.query(
    'UPDATE notification_outbox SET dispatch_outcome_at=$2 WHERE id=$1',
    [intent.id, outcomeAt],
  );
  return intent;
}

describe('dead-letter handled marker (TAB-P1-06 slice 1)', () => {
  it('hides a handled dead letter while keeping an unhandled one, and is idempotent', async () => {
    const handled = await deadLetter(
      ids.clinicA,
      'h1',
      'x',
      '2026-09-13T10:00:00Z',
    );
    const open = await deadLetter(
      ids.clinicA,
      'h2',
      'y',
      '2026-09-13T11:00:00Z',
    );
    expect(await listIds(ids.clinicA)).toEqual([open.id, handled.id]);

    const first = await handle(ids.clinicA, handled.id);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(Object.keys(firstBody).sort()).toEqual(['handledAt', 'intentId']);
    expect(firstBody.intentId).toBe(handled.id);

    expect(await listIds(ids.clinicA)).toEqual([open.id]);

    const second = await handle(ids.clinicA, handled.id);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    const rows = await pool.query(
      'SELECT handled_by FROM notification_dead_letter_handlings WHERE intent_id=$1',
      [handled.id],
    );
    expect(rows.rows).toEqual([{ handled_by: ids.receptionist }]);
  });

  it('answers 404 for another clinic, pending, unknown and malformed intents without changing anything', async () => {
    const other = await deadLetter(
      ids.clinicB,
      'o1',
      'x',
      '2026-09-13T10:00:00Z',
    );
    const pending = await enqueue(ids.clinicA, 'p1');
    for (const id of [other.id, pending.id, randomUUID()]) {
      const response = await handle(ids.clinicA, id);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'not_found' });
    }
    expect((await handle(ids.clinicA, 'not-a-uuid')).status).toBe(400);
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM notification_dead_letter_handlings',
    );
    expect(count.rows[0].n).toBe(0);
  });

  it('refuses unauthenticated, cross-origin, non-member and doctor callers', async () => {
    const dl = await deadLetter(ids.clinicA, 'a1', 'x', '2026-09-13T10:00:00Z');
    expect(
      (await handle(ids.clinicA, dl.id, { authenticated: false })).status,
    ).toBe(401);
    expect(
      (await handle(ids.clinicA, dl.id, { origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
    expect((await handle(ids.clinicA, dl.id, { origin: null })).status).toBe(
      403,
    );
    expect((await handle(ids.clinicB, dl.id)).status).toBe(403);
    await pool.query(
      "UPDATE clinic_memberships SET role='doctor' WHERE user_id=$1",
      [ids.receptionist],
    );
    expect((await handle(ids.clinicA, dl.id)).status).toBe(403);
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM notification_dead_letter_handlings',
    );
    expect(count.rows[0].n).toBe(0);
    // positive control: the same dead letter is still listed and handleable by an allowed role
    await pool.query(
      "UPDATE clinic_memberships SET role='clinic_admin' WHERE user_id=$1",
      [ids.receptionist],
    );
    expect((await handle(ids.clinicA, dl.id)).status).toBe(200);
  });
});
