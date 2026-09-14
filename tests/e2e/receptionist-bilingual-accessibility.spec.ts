import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { QueueService } from '@/modules/queue';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

test('receptionist queue stays clinic-scoped, private, bilingual, and keyboard operable', async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const clinicId = randomUUID();
  const otherClinicId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const doctorUserId = randomUUID();
  const otherDoctorUserId = randomUUID();
  const doctorId = randomUUID();
  const otherDoctorId = randomUUID();
  const sessionId = randomUUID();
  const otherSessionId = randomUUID();
  const subject = `wu48-reception-${userId}`;
  const otherSubject = `wu48-other-reception-${otherUserId}`;
  const doctorSubject = `wu48-doctor-${doctorUserId}`;
  const otherDoctorSubject = `wu48-other-doctor-${otherDoctorUserId}`;
  const privateName = 'WU48 Private Patient Alpha';
  const otherPrivateName = 'WU48 Other Clinic Private Patient';
  const otherClinicMarker = 'WU48 Other Clinic Marker';

  try {
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES
        ($1,$5,'WU48 Reception'),
        ($2,$6,'WU48 Other Reception'),
        ($3,$7,'WU48 Doctor'),
        ($4,$8,'WU48 Other Doctor')`,
      [
        userId,
        otherUserId,
        doctorUserId,
        otherDoctorUserId,
        subject,
        otherSubject,
        doctorSubject,
        otherDoctorSubject,
      ],
    );
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES
        ($1,$3,'WU48 Clinic'),
        ($2,$4,$5)`,
      [
        clinicId,
        otherClinicId,
        `wu48-clinic-${clinicId}`,
        `wu48-other-clinic-${otherClinicId}`,
        otherClinicMarker,
      ],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
        ($1,$3,'receptionist'),
        ($1,$5,'doctor'),
        ($2,$4,'receptionist'),
        ($2,$6,'doctor')`,
      [
        clinicId,
        otherClinicId,
        userId,
        otherUserId,
        doctorUserId,
        otherDoctorUserId,
      ],
    );
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES
        ($1,$3,'د. ليلى'),
        ($2,$4,'Dr Other Clinic')`,
      [doctorId, otherDoctorId, doctorUserId, otherDoctorUserId],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES
        ($1,$3),
        ($2,$4)`,
      [clinicId, otherClinicId, doctorId, otherDoctorId],
    );

    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO consultation_sessions(id,clinic_id,doctor_id,service_date,starts_at,ends_at,status) VALUES
        ($1,$3,$5,$7,$7::date+time '09:00',$7::date+time '12:00','open'),
        ($2,$4,$6,$7,$7::date+time '09:00',$7::date+time '12:00','open')`,
      [
        sessionId,
        otherSessionId,
        clinicId,
        otherClinicId,
        doctorId,
        otherDoctorId,
        today,
      ],
    );

    const queue = new QueueService(pool);
    const scope = { clinicId, actorUserId: userId };
    const first = await queue.registerWalkIn(scope, sessionId, {
      privateDisplayName: privateName,
      preferredLocale: 'ar',
      idempotencyKey: 'wu48-register-1',
      correlationId: 'wu48-register-1',
    });
    const second = await queue.registerWalkIn(scope, sessionId, {
      privateDisplayName: 'WU48 Private Patient Beta',
      preferredLocale: 'fr',
      idempotencyKey: 'wu48-register-2',
      correlationId: 'wu48-register-2',
    });
    await queue.command(scope, sessionId, first.entry.id, {
      command: 'check_in',
      idempotencyKey: 'wu48-check-in-1',
      correlationId: 'wu48-check-in-1',
    });
    await queue.command(scope, sessionId, second.entry.id, {
      command: 'check_in',
      idempotencyKey: 'wu48-check-in-2',
      correlationId: 'wu48-check-in-2',
    });

    const otherScope = { clinicId: otherClinicId, actorUserId: otherUserId };
    const other = await queue.registerWalkIn(otherScope, otherSessionId, {
      privateDisplayName: otherPrivateName,
      preferredLocale: 'fr',
      idempotencyKey: 'wu48-other-register',
      correlationId: 'wu48-other-register',
    });
    await queue.command(otherScope, otherSessionId, other.entry.id, {
      command: 'check_in',
      idempotencyKey: 'wu48-other-check-in',
      correlationId: 'wu48-other-check-in',
    });

    const secret =
      process.env.STAFF_SESSION_SECRET ??
      'browser-test-session-secret-at-least-32-characters';
    process.env.STAFF_SESSION_SECRET = secret;
    await page.context().addCookies([
      {
        name: 'tabibi_staff_session',
        value: createStaffSessionToken(subject, new Date(Date.now() + 60_000)),
        url: 'http://127.0.0.1:3000',
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);

    await page.goto(
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=ar`,
    );

    const main = page.locator('main');
    const receptionView = page.getByLabel('لوحة عمليات الاستقبال');
    await expect(main).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { name: 'قائمة المرضى بدون موعد' }),
    ).toBeVisible();
    await expect(receptionView).toContainText('د. ليلى');
    await expect(receptionView).toContainText('مفتوحة');

    const reorder = page
      .getByRole('button', { name: 'تقديم / إعادة ترتيب (مدقّق)' })
      .nth(1);
    await reorder.focus();
    await expect(reorder).toBeFocused();
    const answers = ['1', 'WU48 keyboard acceptance'];
    page.on('dialog', (dialog) => void dialog.accept(answers.shift()));
    const reorderResponse = page.waitForResponse((response) =>
      response.url().endsWith('/reorder'),
    );
    await reorder.press('Enter');
    expect((await reorderResponse).status()).toBe(200);
    await expect(page.getByText('ترتيب الخدمة #1')).toBeVisible();

    const frenchButton = page.getByRole('button', { name: 'Français' });
    await frenchButton.focus();
    await expect(frenchButton).toBeFocused();
    await frenchButton.press('Enter');
    await expect(main).toHaveAttribute('dir', 'ltr');
    await expect(
      page.getByRole('heading', {
        name: 'File des patients sans rendez-vous',
      }),
    ).toBeVisible();
    await expect(
      page.getByLabel('Vue opérationnelle de la réception'),
    ).toContainText('د. ليلى');

    const body = page.locator('body');
    await expect(body).toContainText(privateName);
    await expect(body).not.toContainText(otherPrivateName);
    await expect(body).not.toContainText(otherClinicMarker);
    await expect(body).not.toContainText(first.entry.id);
    await expect(body).not.toContainText(second.entry.id);
    await expect(body).not.toContainText(other.entry.id);
    await expect(body).not.toContainText(otherClinicId);
    await expect(body).not.toContainText(otherSessionId);
  } finally {
    await pool.end();
  }
});
