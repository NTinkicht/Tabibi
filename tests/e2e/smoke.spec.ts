import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

test('application shell and liveness endpoint are available', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tabibi' })).toBeVisible();
  const health = await request.get('/api/health');
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toMatchObject({
    status: 'ok',
    service: 'tabibi',
  });
});

test('receptionist handles Arabic/French sessions and a contact-less walk-in on mobile', async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const clinicId = '10000000-0000-4000-8000-000000000001';
  const userId = '10000000-0000-4000-8000-000000000002';
  const doctorUserId = '10000000-0000-4000-8000-000000000003';
  const doctorId = '10000000-0000-4000-8000-000000000004';
  const sessionId = '10000000-0000-4000-8000-000000000005';
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
    ($1,'browser-reception','Reception'),($2,'browser-doctor','Doctor') ON CONFLICT DO NOTHING`,
    [userId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'browser-clinic','Browser Clinic') ON CONFLICT DO NOTHING`,
    [clinicId],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES($1,$2,'receptionist') ON CONFLICT DO NOTHING`,
    [clinicId, userId],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'د. أمينة') ON CONFLICT DO NOTHING`,
    [doctorId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [clinicId, doctorId],
  );
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at)
    VALUES($1,$2,$3,$4,$4::date+time '09:00',$4::date+time '12:00') ON CONFLICT DO NOTHING`,
    [sessionId, clinicId, doctorId, today],
  );
  const secret =
    process.env.STAFF_SESSION_SECRET ??
    'browser-test-session-secret-at-least-32-characters';
  process.env.STAFF_SESSION_SECRET = secret;
  await page.context().addCookies([
    {
      name: 'tabibi_staff_session',
      value: createStaffSessionToken(
        'browser-reception',
        new Date(Date.now() + 60_000),
      ),
      url: 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/operations/${clinicId}`);
  await expect(
    page.getByRole('heading', { name: 'جلسات اليوم' }),
  ).toBeVisible();
  await expect(page.getByText('د. أمينة')).toBeVisible();
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sessions du jour' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Patients sans rendez-vous' }).click();
  await expect(
    page.getByRole('heading', { name: 'File des patients sans rendez-vous' }),
  ).toBeVisible();
  await page.getByLabel('Nom à l’accueil').fill('Patient test');
  const registrationResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/sessions/${sessionId}/queue`),
  );
  await page.getByRole('button', { name: 'Ajouter un patient' }).click();
  const registrationResponse = await registrationResponsePromise;
  const registrationBody = await registrationResponse.text();
  expect(registrationResponse.status(), registrationBody).toBe(201);
  await expect(page.getByText('Patient test')).toBeVisible();
  await expect(page.getByText('Sans coordonnées')).toBeVisible();
  await expect(page.getByText(/^W-[A-F0-9]{10}$/)).toBeVisible();
  await pool.end();
});
