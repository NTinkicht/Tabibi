import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GET } from '@/app/api/clinics/[clinicId]/notification-templates/route';
import { notificationTemplateIds } from '@/modules/notification-templates';
import { closePool } from '@/platform/database/pool';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const clinicA = randomUUID();
const clinicB = randomUUID();
const people = {
  admin: { id: randomUUID(), subject: 'tpl-admin', role: 'clinic_admin' },
  reception: { id: randomUUID(), subject: 'tpl-rec', role: 'receptionist' },
  doctor: { id: randomUUID(), subject: 'tpl-doc', role: 'doctor' },
  other: { id: randomUUID(), subject: 'tpl-other', role: 'receptionist' },
};

beforeAll(async () => {
  process.env.STAFF_SESSION_SECRET =
    'tpl-catalogue-session-secret-at-least-32-characters';
  await migrate();
});

beforeEach(async () => {
  await pool.query('TRUNCATE clinic_memberships, clinics, users CASCADE');
  await pool.query(
    `INSERT INTO clinics(id, tenant_key, name) VALUES
      ($1, 'tpl-a', 'TPL A'), ($2, 'tpl-b', 'TPL B')`,
    [clinicA, clinicB],
  );
  for (const p of Object.values(people)) {
    await pool.query(
      `INSERT INTO users(id, auth_subject, display_name) VALUES ($1, $2, $2)`,
      [p.id, p.subject],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [p === people.other ? clinicB : clinicA, p.id, p.role],
    );
  }
});

afterAll(async () => {
  await pool.end();
  await closePool();
});

async function call(subject: string | null, clinicId = clinicA) {
  const headers: Record<string, string> = {};
  if (subject)
    headers.cookie = `tabibi_staff_session=${await createStaffSessionToken(
      subject,
      new Date(Date.now() + 60_000),
    )}`;
  return GET(
    new Request(
      `http://localhost/api/clinics/${clinicId}/notification-templates`,
      {
        headers,
      },
    ),
    { params: Promise.resolve({ clinicId }) },
  );
}

describe('GET /api/clinics/{clinicId}/notification-templates (TAB-P1-06)', () => {
  it.each(['tpl-admin', 'tpl-rec'])('serves the catalogue to %s', async (s) => {
    const response = await call(s);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      templates: { templateId: string }[];
    };
    expect(body.templates.map((t) => t.templateId)).toEqual([
      ...notificationTemplateIds,
    ]);
  });

  it.each([
    ['unauthenticated', null, clinicA],
    ['doctor role', 'tpl-doc', clinicA],
    ['member of another clinic', 'tpl-other', clinicA],
  ])('refuses %s without a catalogue body', async (_name, subject, clinic) => {
    const response = await call(subject, clinic);
    expect([401, 403, 404]).toContain(response.status);
    expect(JSON.stringify(await response.json())).not.toContain('templateId');
  });
});
