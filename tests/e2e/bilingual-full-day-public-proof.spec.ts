import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { QueueService } from '@/modules/queue';

test('proves the WU49 bilingual public projection renders a real row without private identifiers', async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const run = randomUUID();
  const clinicId = randomUUID();
  const receptionistId = randomUUID();
  const doctorUserId = randomUUID();
  const doctorId = randomUUID();
  const sessionId = randomUUID();
  const privateName = `WU49 Public Proof Secret ${run}`;

  try {
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES
        ($1,$3,'WU49 Public Proof Reception'),
        ($2,$4,'WU49 Public Proof Doctor')`,
      [
        receptionistId,
        doctorUserId,
        `wu49-public-proof-reception-${run}`,
        `wu49-public-proof-doctor-${run}`,
      ],
    );
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name)
       VALUES($1,$2,'WU49 Public Proof Clinic')`,
      [clinicId, `wu49-public-proof-clinic-${run}`],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
        ($1,$2,'receptionist'),
        ($1,$3,'doctor')`,
      [clinicId, receptionistId, doctorUserId],
    );
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name)
       VALUES($1,$2,'Dr WU49 Public Proof')`,
      [doctorId, doctorUserId],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
      [clinicId, doctorId],
    );
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
       VALUES($1,$2,$3,$4,$4::date+time '08:00',$4::date+time '18:00','open')`,
      [sessionId, clinicId, doctorId, today],
    );

    const registration = await new QueueService(pool).registerWalkIn(
      { clinicId, actorUserId: receptionistId },
      sessionId,
      {
        privateDisplayName: privateName,
        preferredLocale: 'ar',
        idempotencyKey: `wu49-public-proof-${run}`,
        correlationId: `wu49-public-proof-${run}`,
      },
    );

    await page.goto(`/waiting-room/${clinicId}/${sessionId}`);
    const publicMain = page.locator('main');
    const interactiveWithinProjection = publicMain.locator(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    await expect(publicMain).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('list', { name: 'قاعة الانتظار' }),
    ).toBeVisible();
    await expect(interactiveWithinProjection).toHaveCount(0);
    await expect(
      page.getByText(registration.entry.publicDisplayLabel),
    ).toBeVisible();
    const arabicBody = await page.locator('body').innerText();
    expect(arabicBody).not.toContain(privateName);
    expect(arabicBody).not.toContain(registration.patient.id);
    expect(arabicBody).not.toContain(registration.entry.id);

    await page.goto(`/waiting-room/${clinicId}/${sessionId}?lang=fr`);
    await expect(publicMain).toHaveAttribute('dir', 'ltr');
    await expect(
      page.getByRole('list', { name: "Salle d'attente" }),
    ).toBeVisible();
    await expect(interactiveWithinProjection).toHaveCount(0);
    await expect(
      page.getByText(registration.entry.publicDisplayLabel),
    ).toBeVisible();
    const frenchBody = await page.locator('body').innerText();
    expect(frenchBody).not.toContain(privateName);
    expect(frenchBody).not.toContain(registration.patient.id);
    expect(frenchBody).not.toContain(registration.entry.id);
  } finally {
    await pool.end();
  }
});
