import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { QueueService } from '@/modules/queue';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

test('mobile Arabic queue view reloads safely after a stale reorder conflict and can switch back to French', async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const clinicId = randomUUID();
  const userId = randomUUID();
  const doctorUserId = randomUUID();
  const doctorId = randomUUID();
  const sessionId = randomUUID();

  let stalePage: Page | undefined;
  try {
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES
        ($1,'browser-queue-reception','Reception'),
        ($2,'browser-queue-doctor','Doctor')`,
      [userId, doctorUserId],
    );
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'browser-queue-clinic','Browser Queue Clinic')`,
      [clinicId],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
        ($1,$2,'receptionist'),
        ($1,$3,'doctor')`,
      [clinicId, userId, doctorUserId],
    );
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'د. ليلى')`,
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

    const queue = new QueueService(pool);
    const scope = { clinicId, actorUserId: userId };
    const first = await queue.registerWalkIn(scope, sessionId, {
      privateDisplayName: 'المريض الأول',
      preferredLocale: 'ar',
      idempotencyKey: 'browser-queue-register-1',
      correlationId: 'browser-queue-register-1',
    });
    const second = await queue.registerWalkIn(scope, sessionId, {
      privateDisplayName: 'المريض الثاني',
      preferredLocale: 'fr',
      idempotencyKey: 'browser-queue-register-2',
      correlationId: 'browser-queue-register-2',
    });
    await queue.command(scope, sessionId, first.entry.id, {
      command: 'check_in',
      idempotencyKey: 'browser-queue-check-in-1',
      correlationId: 'browser-queue-check-in-1',
    });
    await queue.command(scope, sessionId, second.entry.id, {
      command: 'check_in',
      idempotencyKey: 'browser-queue-check-in-2',
      correlationId: 'browser-queue-check-in-2',
    });

    const secret =
      process.env.STAFF_SESSION_SECRET ??
      'browser-test-session-secret-at-least-32-characters';
    process.env.STAFF_SESSION_SECRET = secret;
    await page.context().addCookies([
      {
        name: 'tabibi_staff_session',
        value: createStaffSessionToken(
          'browser-queue-reception',
          new Date(Date.now() + 60_000),
        ),
        url: 'http://127.0.0.1:3000',
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=ar`,
    );
    await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { name: 'قائمة المرضى بدون موعد' }),
    ).toBeVisible();
    await expect(page.getByLabel('لوحة عمليات الاستقبال')).toContainText(
      'د. ليلى',
    );
    await expect(page.getByLabel('لوحة عمليات الاستقبال')).toContainText(
      'مفتوحة',
    );

    stalePage = await page.context().newPage();
    await stalePage.setViewportSize({ width: 390, height: 844 });
    await stalePage.goto(
      `/operations/${clinicId}/sessions/${sessionId}/queue?locale=ar`,
    );
    await expect(stalePage.locator('main')).toHaveAttribute('dir', 'rtl');

    const firstAnswers = ['1', 'سبب تشغيلي للاختبار'];
    page.on('dialog', (dialog) => void dialog.accept(firstAnswers.shift()));
    const firstResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/reorder'),
    );
    await page
      .getByRole('button', { name: 'تقديم / إعادة ترتيب (مدقّق)' })
      .nth(1)
      .click();
    expect((await firstResponsePromise).status()).toBe(200);
    await expect(page.getByText('ترتيب الخدمة #1')).toBeVisible();

    const staleAnswers = ['1', 'محاولة ببيانات قديمة'];
    stalePage.on(
      'dialog',
      (dialog) => void dialog.accept(staleAnswers.shift()),
    );
    const staleResponsePromise = stalePage.waitForResponse((response) =>
      response.url().endsWith('/reorder'),
    );
    await stalePage
      .getByRole('button', { name: 'تقديم / إعادة ترتيب (مدقّق)' })
      .nth(0)
      .click();
    expect((await staleResponsePromise).status()).toBe(409);
    await expect(
      stalePage
        .getByRole('alert')
        .filter({ hasText: 'Stale queue order version' }),
    ).toBeVisible();
    await expect(stalePage.locator('main')).toHaveAttribute('dir', 'rtl');

    await stalePage.getByRole('button', { name: 'Français' }).click();
    await expect(stalePage.locator('main')).toHaveAttribute('dir', 'ltr');
    await expect(
      stalePage.getByRole('heading', {
        name: 'File des patients sans rendez-vous',
      }),
    ).toBeVisible();
    await stalePage.setViewportSize({ width: 1280, height: 800 });
    await expect(
      stalePage.getByLabel('Vue opérationnelle de la réception'),
    ).toContainText('د. ليلى');
  } finally {
    await stalePage?.close();
    await pool.end();
  }
});
