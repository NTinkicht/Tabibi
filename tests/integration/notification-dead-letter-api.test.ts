import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GET } from '@/app/api/clinics/[clinicId]/notifications/dead-letters/route';
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
    'TRUNCATE notification_outbox, clinic_memberships, clinics, users CASCADE',
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

function authCookie() {
  return `tabibi_staff_session=${createStaffSessionToken(
    authSubject,
    new Date(Date.now() + 60_000),
  )}`;
}

function request(clinicId: string, query = '', authenticated = true) {
  return new Request(
    `http://localhost/api/clinics/${clinicId}/notifications/dead-letters${query}`,
    authenticated ? { headers: { cookie: authCookie() } } : undefined,
  );
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

describe('notification dead-letter HTTP boundary', () => {
  it('rejects unauthenticated reads and disables caching', async () => {
    const response = await GET(
      request(ids.clinicA, '', false),
      context(ids.clinicA),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'authentication_required',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns only bounded privacy-minimal dead letters for an authorized clinic', async () => {
    const older = await deadLetter(
      ids.clinicA,
      'older',
      'provider_timeout',
      '2026-09-13T10:00:00Z',
    );
    const newer = await deadLetter(
      ids.clinicA,
      'newer',
      'provider_unknown',
      '2026-09-13T11:00:00Z',
    );
    await deadLetter(
      ids.clinicB,
      'other-clinic',
      'other_clinic_failure',
      '2026-09-13T12:00:00Z',
    );
    await enqueue(ids.clinicA, 'still-pending');

    const response = await GET(
      request(ids.clinicA, '?limit=1'),
      context(ids.clinicA),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      deadLetters: Array<Record<string, unknown>>;
    };
    expect(body.deadLetters).toEqual([
      {
        intentId: newer.id,
        eventKey: 'turn_approaching',
        queueEntryId: null,
        outcomeCode: 'provider_unknown',
        attemptCount: 1,
        maxAttempts: 1,
        outcomeAt: '2026-09-13T11:00:00.000Z',
      },
    ]);
    expect(body.deadLetters).not.toContainEqual(
      expect.objectContaining({ intentId: older.id }),
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('private rendered body');
    expect(serialized).not.toContain('+971500000000');
    expect(serialized).not.toContain('patient-private:');
    expect(serialized).not.toContain('private-idempotency:');
    expect(serialized).not.toContain('other_clinic_failure');
  });

  it('fails closed for a clinic where the authenticated staff member has no allowed membership', async () => {
    const response = await GET(request(ids.clinicB), context(ids.clinicB));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'forbidden' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects invalid limits before querying the observability repository', async () => {
    const response = await GET(
      request(ids.clinicA, '?limit=101'),
      context(ids.clinicA),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
