import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { QueueService } from '@/modules/queue';

test('public waiting-room renders Arabic RTL and French LTR without PII', async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const clinicId = randomUUID();
  const receptionistId = randomUUID();
  const doctorUserId = randomUUID();
  const doctorId = randomUUID();
  const sessionId = randomUUID();
  const privateName = 'Browser Secret Patient';
  const privatePhone = '+213555987654';
  const privateEmail = 'browser.secret@example.dz';

  try {
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES
        ($1,'waiting-room-reception','Reception'),
        ($2,'waiting-room-doctor','Doctor')`,
      [receptionistId, doctorUserId],
    );
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name)
       VALUES($1,'waiting-room-browser-clinic','Waiting Room Browser Clinic')`,
      [clinicId],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
        ($1,$2,'receptionist'),
        ($1,$3,'doctor')`,
      [clinicId, receptionistId, doctorUserId],
    );
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name)
       VALUES($1,$2,'Dr Browser')`,
      [doctorId, doctorUserId],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [clinicId, doctorId],
    );
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
       VALUES($1,$2,$3,$4,$4::date+time '09:00',$4::date+time '12:00','open')`,
      [sessionId, clinicId, doctorId, today],
    );

    const registration = await new QueueService(pool).registerWalkIn(
      { clinicId, actorUserId: receptionistId },
      sessionId,
      {
        privateDisplayName: privateName,
        contactPhone: privatePhone,
        contactEmail: privateEmail,
        preferredLocale: 'ar',
        idempotencyKey: 'waiting-room-browser-register',
        correlationId: 'waiting-room-browser-register',
      },
    );

    await page.goto(`/waiting-room/${clinicId}/${sessionId}`);
    await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { name: 'قاعة الانتظار' }),
    ).toBeVisible();
    await expect(
      page.getByText(registration.entry.publicDisplayLabel),
    ).toBeVisible();
    await expect(page.getByText('في الانتظار')).toBeVisible();

    const arabicBody = await page.locator('body').innerText();
    expect(arabicBody).not.toContain(privateName);
    expect(arabicBody).not.toContain(privatePhone);
    expect(arabicBody).not.toContain(privateEmail);
    expect(arabicBody).not.toContain(registration.patient.id);
    expect(arabicBody).not.toContain(registration.entry.id);

    await page.goto(`/waiting-room/${clinicId}/${sessionId}?lang=fr`);
    await expect(page.locator('main')).toHaveAttribute('dir', 'ltr');
    await expect(
      page.getByRole('heading', { name: "Salle d'attente" }),
    ).toBeVisible();
    await expect(
      page.getByText(registration.entry.publicDisplayLabel),
    ).toBeVisible();
    await expect(page.getByText('En attente')).toBeVisible();

    const frenchBody = await page.locator('body').innerText();
    expect(frenchBody).not.toContain(privateName);
    expect(frenchBody).not.toContain(privatePhone);
    expect(frenchBody).not.toContain(privateEmail);
    expect(frenchBody).not.toContain(registration.patient.id);
    expect(frenchBody).not.toContain(registration.entry.id);
  } finally {
    await pool.end();
  }
});
