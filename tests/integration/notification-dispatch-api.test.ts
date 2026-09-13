import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST } from '@/app/api/clinics/[clinicId]/notifications/dispatch/route';
import { QueueNotificationProducer } from '@/modules/notification-domain';
import { InAppNotificationInboxRepository } from '@/modules/notification-inbox';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { NotificationPreferenceRepository } from '@/modules/notification-preferences';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinicA: randomUUID(),
  clinicB: randomUUID(),
  receptionist: randomUUID(),
  doctorUserA: randomUUID(),
  doctorUserB: randomUUID(),
  doctorA: randomUUID(),
  doctorB: randomUUID(),
  sessionA: randomUUID(),
  sessionB: randomUUID(),
  patientA: randomUUID(),
  patientB: randomUUID(),
  queueEntryA: randomUUID(),
  queueEntryB: randomUUID(),
};

const authSubject = 'wu41-reception';
const secret = 'wu41-api-test-session-secret-at-least-32-characters';

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = secret;
  await migrate();
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE notification_inbox_items, notification_preference_receipts, notification_preferences, notification_outbox, clinic_memberships, clinics, users CASCADE',
  );
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name)
     VALUES ($1, $2, 'WU41 Reception'),
            ($3, 'wu41-doctor-a', 'Doctor A'),
            ($4, 'wu41-doctor-b', 'Doctor B')`,
    [ids.receptionist, authSubject, ids.doctorUserA, ids.doctorUserB],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name)
     VALUES ($1, 'wu41-a', 'WU41 A'),
            ($2, 'wu41-b', 'WU41 B')`,
    [ids.clinicA, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role)
     VALUES ($1, $2, 'receptionist')`,
    [ids.clinicA, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name)
     VALUES ($1, $2, 'Doctor A'), ($3, $4, 'Doctor B')`,
    [ids.doctorA, ids.doctorUserA, ids.doctorB, ids.doctorUserB],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id)
     VALUES ($1, $2), ($3, $4)`,
    [ids.clinicA, ids.doctorA, ids.clinicB, ids.doctorB],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES
       ($1, $2, $3, '2026-09-13', '2026-09-13T08:00Z', '2026-09-13T12:00Z', 'open'),
       ($4, $5, $6, '2026-09-13', '2026-09-13T08:00Z', '2026-09-13T12:00Z', 'open')`,
    [
      ids.sessionA,
      ids.clinicA,
      ids.doctorA,
      ids.sessionB,
      ids.clinicB,
      ids.doctorB,
    ],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
       (id, clinic_id, private_display_name)
     VALUES ($1, $2, 'Patient A'), ($3, $4, 'Patient B')`,
    [ids.patientA, ids.clinicA, ids.patientB, ids.clinicB],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id, clinic_id, session_id, patient_id, state, source, registration_order,
        public_display_label)
     VALUES
       ($1, $2, $3, $4, 'waiting', 'walk_in', 1, 'A-001'),
       ($5, $6, $7, $8, 'waiting', 'walk_in', 1, 'B-001')`,
    [
      ids.queueEntryA,
      ids.clinicA,
      ids.sessionA,
      ids.patientA,
      ids.queueEntryB,
      ids.clinicB,
      ids.sessionB,
      ids.patientB,
    ],
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

function request(
  clinicId: string,
  query = '',
  options: { authenticated?: boolean; origin?: string } = {},
) {
  const authenticated = options.authenticated ?? true;
  const origin = options.origin ?? 'http://localhost';
  const headers = new Headers({ origin });
  if (authenticated) headers.set('cookie', authCookie());
  return new Request(
    `http://localhost/api/clinics/${clinicId}/notifications/dispatch${query}`,
    { method: 'POST', headers },
  );
}

function context(clinicId: string) {
  return { params: Promise.resolve({ clinicId }) };
}

function queueCreated(
  clinicId: string,
  queueEntryId: string,
  sourceEventId: string,
) {
  return {
    clinicId,
    queueEntryId,
    sourceEventId,
    sourceVersion: 1,
    notification: {
      eventKey: 'queue_entry_created' as const,
      locale: 'fr',
    },
  };
}

async function enableInApp(
  clinicId: string,
  patientId: string,
  idempotencyKey: string,
) {
  return new NotificationPreferenceRepository(pool).change({
    clinicId,
    subjectKind: 'visit_patient',
    subjectId: patientId,
    channel: 'in_app',
    preferenceState: 'enabled',
    consentState: 'not_required',
    idempotencyKey,
  });
}

async function produce(
  clinicId: string,
  queueEntryId: string,
  sourceEventId: string,
) {
  return new QueueNotificationProducer(
    new NotificationOutboxRepository(pool),
  ).produce(queueCreated(clinicId, queueEntryId, sourceEventId));
}

describe('notification dispatch HTTP boundary', () => {
  it('rejects unauthenticated and cross-origin mutation attempts', async () => {
    const unauthenticated = await POST(
      request(ids.clinicA, '', { authenticated: false }),
      context(ids.clinicA),
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: 'authentication_required',
    });
    expect(unauthenticated.headers.get('cache-control')).toBe('no-store');

    const crossOrigin = await POST(
      request(ids.clinicA, '', { origin: 'https://evil.example' }),
      context(ids.clinicA),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({ error: 'csrf_rejected' });
    expect(crossOrigin.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects malformed clinic ids before dispatch state can change', async () => {
    await enableInApp(ids.clinicA, ids.patientA, 'wu41-pref-malformed-clinic');
    const intent = await produce(
      ids.clinicA,
      ids.queueEntryA,
      'wu41-event-malformed-clinic',
    );
    const before = await pool.query<{
      state: string;
      dispatch_attempt_count: number;
    }>(
      `SELECT state, dispatch_attempt_count
         FROM notification_outbox
        WHERE id=$1`,
      [intent.id],
    );
    expect(before.rows[0]).toMatchObject({
      state: 'pending',
      dispatch_attempt_count: 0,
    });

    const response = await POST(request('not-a-uuid'), context('not-a-uuid'));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(response.headers.get('cache-control')).toBe('no-store');

    const after = await pool.query<{
      state: string;
      dispatch_attempt_count: number;
    }>(
      `SELECT state, dispatch_attempt_count
         FROM notification_outbox
        WHERE id=$1`,
      [intent.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    const inboxCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM notification_inbox_items',
    );
    expect(inboxCount.rows[0]?.count).toBe('0');
  });

  it('dispatches an eligible same-clinic intent to the exact patient and returns only an aggregate summary', async () => {
    await enableInApp(ids.clinicA, ids.patientA, 'wu41-pref-a');
    const intent = await produce(
      ids.clinicA,
      ids.queueEntryA,
      'wu41-event-authorized',
    );

    const response = await POST(request(ids.clinicA), context(ids.clinicA));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      summary: {
        selected: 1,
        completed: 1,
        suppressed: 0,
        notClaimed: 0,
        claimLost: 0,
        errors: 0,
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(intent.id);
    expect(serialized).not.toContain(ids.patientA);
    expect(serialized).not.toContain(ids.queueEntryA);

    const inbox = new InAppNotificationInboxRepository(pool);
    await expect(
      inbox.listForSubject({
        clinicId: ids.clinicA,
        subjectKind: 'visit_patient',
        subjectId: ids.patientA,
        limit: 20,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      inbox.listForSubject({
        clinicId: ids.clinicB,
        subjectKind: 'visit_patient',
        subjectId: ids.patientB,
        limit: 20,
      }),
    ).resolves.toHaveLength(0);
  });

  it('denies cross-clinic staff access without dispatching that clinic work', async () => {
    await enableInApp(ids.clinicB, ids.patientB, 'wu41-pref-b');
    const intent = await produce(
      ids.clinicB,
      ids.queueEntryB,
      'wu41-event-cross-clinic',
    );

    const response = await POST(request(ids.clinicB), context(ids.clinicB));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'forbidden' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const row = await pool.query<{ state: string }>(
      'SELECT state FROM notification_outbox WHERE id=$1',
      [intent.id],
    );
    expect(row.rows[0]?.state).toBe('pending');
    await expect(
      new InAppNotificationInboxRepository(pool).listForSubject({
        clinicId: ids.clinicB,
        subjectKind: 'visit_patient',
        subjectId: ids.patientB,
        limit: 20,
      }),
    ).resolves.toHaveLength(0);
  });

  it('rejects invalid limits before dispatching eligible work', async () => {
    await enableInApp(ids.clinicA, ids.patientA, 'wu41-pref-limit');
    const intent = await produce(
      ids.clinicA,
      ids.queueEntryA,
      'wu41-event-invalid-limit',
    );

    const response = await POST(
      request(ids.clinicA, '?limit=101'),
      context(ids.clinicA),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    const row = await pool.query<{ state: string }>(
      'SELECT state FROM notification_outbox WHERE id=$1',
      [intent.id],
    );
    expect(row.rows[0]?.state).toBe('pending');
  });

  it('suppresses missing-preference work once and remains idempotent on the next trigger', async () => {
    const intent = await produce(
      ids.clinicA,
      ids.queueEntryA,
      'wu41-event-no-preference',
    );

    const first = await POST(request(ids.clinicA), context(ids.clinicA));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      summary: {
        selected: 1,
        completed: 0,
        suppressed: 1,
        notClaimed: 0,
        claimLost: 0,
        errors: 0,
      },
    });

    const state = await pool.query<{ state: string }>(
      'SELECT state FROM notification_outbox WHERE id=$1',
      [intent.id],
    );
    expect(state.rows[0]?.state).toBe('suppressed');

    const second = await POST(request(ids.clinicA), context(ids.clinicA));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      summary: {
        selected: 0,
        completed: 0,
        suppressed: 0,
        notClaimed: 0,
        claimLost: 0,
        errors: 0,
      },
    });
    await expect(
      new InAppNotificationInboxRepository(pool).listForSubject({
        clinicId: ids.clinicA,
        subjectKind: 'visit_patient',
        subjectId: ids.patientA,
        limit: 20,
      }),
    ).resolves.toHaveLength(0);
  });
});
