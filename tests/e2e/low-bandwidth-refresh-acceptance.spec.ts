import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { QueueNotificationProducer } from '@/modules/notification-domain';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { QueueService } from '@/modules/queue';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

test('WU50 converges after delayed refresh without duplicate mutation or privacy leakage', async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const run = randomUUID();
  const clinicId = randomUUID();
  const otherClinicId = randomUUID();
  const receptionistId = randomUUID();
  const otherReceptionistId = randomUUID();
  const doctorUserId = randomUUID();
  const otherDoctorUserId = randomUUID();
  const doctorId = randomUUID();
  const otherDoctorId = randomUUID();
  const sessionId = randomUUID();
  const otherSessionId = randomUUID();
  const subject = `wu50-reception-${run}`;
  const privateName = `WU50 Private ${run}`;
  const otherPrivateName = `WU50 Other Private ${run}`;

  try {
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES
        ($1,$5,'WU50 Reception'),
        ($2,$6,'WU50 Other Reception'),
        ($3,$7,'WU50 Doctor'),
        ($4,$8,'WU50 Other Doctor')`,
      [
        receptionistId,
        otherReceptionistId,
        doctorUserId,
        otherDoctorUserId,
        subject,
        `wu50-other-reception-${run}`,
        `wu50-doctor-${run}`,
        `wu50-other-doctor-${run}`,
      ],
    );
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES
        ($1,$3,'WU50 Clinic'),
        ($2,$4,'WU50 Other Clinic')`,
      [
        clinicId,
        otherClinicId,
        `wu50-clinic-${run}`,
        `wu50-other-clinic-${run}`,
      ],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
        ($1,$3,'receptionist'),
        ($2,$4,'receptionist'),
        ($1,$5,'doctor'),
        ($2,$6,'doctor')`,
      [
        clinicId,
        otherClinicId,
        receptionistId,
        otherReceptionistId,
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
        ($1,$3),($2,$4)`,
      [clinicId, otherClinicId, doctorId, otherDoctorId],
    );

    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO consultation_sessions
        (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
       VALUES
        ($1,$3,$5,$7,$7::date+time '08:00',$7::date+time '18:00','open'),
        ($2,$4,$6,$7,$7::date+time '08:00',$7::date+time '18:00','open')`,
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
    const notificationProducer = new QueueNotificationProducer(
      new NotificationOutboxRepository(pool),
    );
    const scope = { clinicId, actorUserId: receptionistId };
    const otherScope = {
      clinicId: otherClinicId,
      actorUserId: otherReceptionistId,
    };
    const patient = await queue.registerWalkIn(scope, sessionId, {
      privateDisplayName: privateName,
      preferredLocale: 'ar',
      idempotencyKey: `wu50-register-${run}`,
      correlationId: `wu50-register-${run}`,
    });
    const other = await queue.registerWalkIn(otherScope, otherSessionId, {
      privateDisplayName: otherPrivateName,
      preferredLocale: 'fr',
      idempotencyKey: `wu50-other-${run}`,
      correlationId: `wu50-other-${run}`,
    });
    await queue.command(scope, sessionId, patient.entry.id, {
      command: 'check_in',
      idempotencyKey: `wu50-checkin-${run}`,
      correlationId: `wu50-checkin-${run}`,
    });
    const notification = await notificationProducer.produce({
      clinicId,
      queueEntryId: patient.entry.id,
      sourceEventId: `wu50-refresh-guard-${run}`,
      sourceVersion: 1,
      notification: { eventKey: 'queue_entry_created', locale: 'ar' },
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

    const dashboardUrl = `/api/clinics/${clinicId}/sessions/${sessionId}/dashboard`;
    let dashboardRequests = 0;
    await page.route(`**${dashboardUrl}`, async (route) => {
      dashboardRequests += 1;
      if (dashboardRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await route.continue();
    });

    await page.goto(
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=ar`,
    );
    const row = page
      .locator('article.queueRow')
      .filter({ hasText: privateName });
    await expect(row).toContainText('حاضر');
    await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');

    const outboxBefore = await pool.query<{
      state: string;
      dispatch_attempt_count: number;
    }>(
      `SELECT state::text, dispatch_attempt_count
         FROM notification_outbox
        WHERE id=$1 AND clinic_id=$2`,
      [notification.id, clinicId],
    );
    expect(outboxBefore.rows[0]).toEqual({
      state: 'pending',
      dispatch_attempt_count: 0,
    });

    let commandRequests = 0;
    await page.route(
      `**/api/clinics/${clinicId}/sessions/${sessionId}/queue/${patient.entry.id}/commands`,
      async (route) => {
        commandRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.continue();
      },
    );
    await row.getByRole('button', { name: 'نداء' }).click();
    await expect(row).toContainText('تم النداء');
    expect(commandRequests).toBe(1);

    await queue.command(scope, sessionId, patient.entry.id, {
      command: 'start_consultation',
      idempotencyKey: `wu50-start-${run}`,
      correlationId: `wu50-start-${run}`,
    });
    await page.getByRole('button', { name: 'تحديث' }).click();
    await expect(row).toContainText('في الاستشارة');

    await queue.command(scope, sessionId, patient.entry.id, {
      command: 'complete_consultation',
      idempotencyKey: `wu50-complete-${run}`,
      correlationId: `wu50-complete-${run}`,
    });
    await page.reload();
    const terminalRow = page
      .locator('article.queueRow')
      .filter({ hasText: privateName });
    await expect(terminalRow).toContainText('مكتمل');
    await page.getByRole('button', { name: 'تحديث' }).click();
    await expect(terminalRow).toContainText('مكتمل');
    await expect(terminalRow).not.toContainText('تم النداء');

    await page.getByRole('button', { name: 'Français' }).click();
    await expect(page.locator('main')).toHaveAttribute('dir', 'ltr');
    await expect(terminalRow).toContainText('Terminé');
    await expect(page.locator('body')).not.toContainText(otherPrivateName);
    await expect(page.locator('body')).not.toContainText(other.entry.id);
    await expect(page.locator('body')).not.toContainText(otherClinicId);

    const outboxAfter = await pool.query<{
      state: string;
      dispatch_attempt_count: number;
    }>(
      `SELECT state::text, dispatch_attempt_count
         FROM notification_outbox
        WHERE id=$1 AND clinic_id=$2`,
      [notification.id, clinicId],
    );
    expect(outboxAfter.rows[0]).toEqual(outboxBefore.rows[0]);

    const publicPatient = await queue.registerWalkIn(scope, sessionId, {
      privateDisplayName: `WU50 Public Private ${run}`,
      preferredLocale: 'ar',
      idempotencyKey: `wu50-public-${run}`,
      correlationId: `wu50-public-${run}`,
    });
    await queue.command(scope, sessionId, publicPatient.entry.id, {
      command: 'check_in',
      idempotencyKey: `wu50-public-checkin-${run}`,
      correlationId: `wu50-public-checkin-${run}`,
    });

    await page.goto(`/waiting-room/${clinicId}/${sessionId}`);
    await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByText(publicPatient.entry.publicDisplayLabel),
    ).toBeVisible();
    let body = await page.locator('body').innerText();
    expect(body).not.toContain(publicPatient.patient.privateDisplayName);
    expect(body).not.toContain(publicPatient.patient.id);
    expect(body).not.toContain(publicPatient.entry.id);
    expect(body).not.toContain(otherPrivateName);
    expect(body).not.toContain(other.entry.publicDisplayLabel);

    await queue.command(scope, sessionId, publicPatient.entry.id, {
      command: 'call',
      idempotencyKey: `wu50-public-call-${run}`,
      correlationId: `wu50-public-call-${run}`,
    });
    await page.reload();
    const publicRow = page
      .locator('li')
      .filter({ hasText: publicPatient.entry.publicDisplayLabel });
    await expect(publicRow).toContainText('تم النداء');
    body = await page.locator('body').innerText();
    expect(body).not.toContain(other.entry.publicDisplayLabel);

    await page.goto(`/waiting-room/${clinicId}/${sessionId}?lang=fr`);
    await expect(page.locator('main')).toHaveAttribute('dir', 'ltr');
    const publicRowFr = page
      .locator('li')
      .filter({ hasText: publicPatient.entry.publicDisplayLabel });
    await expect(publicRowFr).toContainText('Appelé');
    body = await page.locator('body').innerText();
    expect(body).not.toContain(publicPatient.patient.privateDisplayName);
    expect(body).not.toContain(publicPatient.patient.id);
    expect(body).not.toContain(publicPatient.entry.id);
    expect(body).not.toContain(other.entry.publicDisplayLabel);
  } finally {
    await pool.end();
  }
});
