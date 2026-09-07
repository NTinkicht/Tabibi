import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { POST as commandPost } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/commands/route';
import { POST as reorderPost } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/[entryId]/reorder/route';
import {
  GET as queueGet,
  POST as queuePost,
} from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/queue/route';
import { QueueService } from '@/modules/queue';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const ids = {
  clinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};

const secret = 'queue-api-test-session-secret-at-least-32-characters';

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET = secret;
  await migrate();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'queue-api-reception','Reception'),
      ($2,'queue-api-doctor','Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'queue-api-clinic','Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
      ($1,$2,'receptionist'),
      ($1,$3,'doctor')`,
    [ids.clinic, ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE+time '09:00',CURRENT_DATE+time '12:00','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

function authCookie() {
  return `tabibi_staff_session=${createStaffSessionToken(
    'queue-api-reception',
    new Date(Date.now() + 60_000),
  )}`;
}

function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(url, {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
      cookie: authCookie(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('queue HTTP negative boundaries', () => {
  it('rejects unauthenticated queue reads', async () => {
    const response = await queueGet(
      new Request(
        `http://localhost/api/clinics/${ids.clinic}/sessions/${ids.session}/queue`,
      ),
      {
        params: Promise.resolve({
          clinicId: ids.clinic,
          sessionId: ids.session,
        }),
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'authentication_required',
    });
  });

  it('rejects registration without an idempotency key after auth and same-origin checks succeed', async () => {
    const response = await queuePost(
      jsonRequest(
        `http://localhost/api/clinics/${ids.clinic}/sessions/${ids.session}/queue`,
        {
          privateDisplayName: 'Queue API patient',
          contactPhone: null,
          contactEmail: null,
          preferredLocale: 'ar',
        },
      ),
      {
        params: Promise.resolve({
          clinicId: ids.clinic,
          sessionId: ids.session,
        }),
      },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      message: string;
    };
    expect(body.error).toBe('invalid_request');
    expect(body.message).toContain('Idempotency key');
  });

  it('rejects reasonless command mutations with safe 400 responses', async () => {
    const queue = new QueueService(pool);
    const registration = await queue.registerWalkIn(
      { clinicId: ids.clinic, actorUserId: ids.receptionist },
      ids.session,
      {
        privateDisplayName: 'No show candidate',
        preferredLocale: 'fr',
        idempotencyKey: 'queue-api-register',
        correlationId: 'queue-api-register',
      },
    );

    const noShow = await commandPost(
      jsonRequest(
        `http://localhost/api/clinics/${ids.clinic}/sessions/${ids.session}/queue/${registration.entry.id}/commands`,
        { command: 'no_show' },
        { 'idempotency-key': 'queue-api-command-1' },
      ),
      {
        params: Promise.resolve({
          clinicId: ids.clinic,
          sessionId: ids.session,
          entryId: registration.entry.id,
        }),
      },
    );
    expect(noShow.status).toBe(400);
    const noShowBody = (await noShow.json()) as {
      error: string;
      message: string;
    };
    expect(noShowBody.error).toBe('invalid_request');
    expect(noShowBody.message).toContain('A reason is required');

    const cancel = await commandPost(
      jsonRequest(
        `http://localhost/api/clinics/${ids.clinic}/sessions/${ids.session}/queue/${registration.entry.id}/commands`,
        { command: 'cancel', reason: 'patient asked' },
        { 'idempotency-key': 'queue-api-command-2' },
      ),
      {
        params: Promise.resolve({
          clinicId: ids.clinic,
          sessionId: ids.session,
          entryId: registration.entry.id,
        }),
      },
    );
    expect(cancel.status).toBe(400);
    const cancelBody = (await cancel.json()) as {
      error: string;
      message: string;
    };
    expect(cancelBody.error).toBe('invalid_request');
    expect(cancelBody.message).toContain('Cancellation source is required');
  });

  it('rejects invalid reorder payloads before they can mutate queue state', async () => {
    const queue = new QueueService(pool);
    const registration = await queue.registerWalkIn(
      { clinicId: ids.clinic, actorUserId: ids.receptionist },
      ids.session,
      {
        privateDisplayName: 'Priority candidate',
        preferredLocale: 'ar',
        idempotencyKey: 'queue-api-register-2',
        correlationId: 'queue-api-register-2',
      },
    );
    await queue.command(
      { clinicId: ids.clinic, actorUserId: ids.receptionist },
      ids.session,
      registration.entry.id,
      {
        command: 'check_in',
        idempotencyKey: 'queue-api-check-in',
        correlationId: 'queue-api-check-in',
      },
    );

    const response = await reorderPost(
      jsonRequest(
        `http://localhost/api/clinics/${ids.clinic}/sessions/${ids.session}/queue/${registration.entry.id}/reorder`,
        {
          targetPosition: 0,
          expectedVersion: 1,
          reason: '',
        },
        { 'idempotency-key': 'queue-api-reorder' },
      ),
      {
        params: Promise.resolve({
          clinicId: ids.clinic,
          sessionId: ids.session,
          entryId: registration.entry.id,
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'invalid_request',
    });
  });
});
