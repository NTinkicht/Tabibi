import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { QueueService } from '@/modules/queue';

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
];

async function seed(pool: Pool) {
  const clinicId = randomUUID();
  const receptionistId = randomUUID();
  const doctorUserId = randomUUID();
  const doctorId = randomUUID();
  const sessionId = randomUUID();
  const run = randomUUID().slice(0, 8);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES ($1,$3,'Reception'),($2,$4,'Doctor')`,
    [receptionistId, doctorUserId, `tv-rec-${run}`, `tv-doc-${run}`],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,$2,'TV Clinic')`,
    [clinicId, `tv-clinic-${run}`],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES ($1,$2,'receptionist'),($1,$3,'doctor')`,
    [clinicId, receptionistId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr TV')`,
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
  const scope = { clinicId, actorUserId: receptionistId };
  let n = 0;
  const patient = async (state: 'waiting' | 'checked_in' | 'called') => {
    n += 1;
    const key = `tv-${run}-${n}`;
    const name = `TV Secret ${run} ${n}`;
    const registration = await queue.registerWalkIn(scope, sessionId, {
      privateDisplayName: name,
      contactPhone: `+2135559${String(10000 + n)}`,
      preferredLocale: 'ar',
      idempotencyKey: key,
      correlationId: key,
    });
    for (const command of state === 'waiting'
      ? []
      : state === 'checked_in'
        ? (['check_in'] as const)
        : (['check_in', 'call'] as const)) {
      await queue.command(scope, sessionId, registration.entry.id, {
        command,
        idempotencyKey: `${key}-${command}`,
        correlationId: `${key}-${command}`,
      });
    }
    return {
      label: registration.entry.publicDisplayLabel,
      name,
      ids: [registration.patient.id, registration.entry.id],
    };
  };
  return { clinicId, sessionId, patient };
}

async function expectNoLeak(page: Page, hidden: string[], routeIds: string[]) {
  const body = await page.locator('body').innerText();
  const html = await page.content();
  for (const value of hidden) {
    expect(body).not.toContain(value);
    expect(html).not.toContain(value);
  }
  // The route ids are part of the URL (Next serialises them in its router
  // state), but they must never be rendered into the visible display.
  for (const value of routeIds) expect(body).not.toContain(value);
}

test.describe('waiting-room TV display', () => {
  let pool: Pool;
  test.beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  test.afterAll(async () => {
    await pool.end();
  });

  for (const viewport of VIEWPORTS) {
    test(`renders called, next, counts and no identifiers at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const ctx = await seed(pool);
      const second = await ctx.patient('called');
      const nextLabels = [];
      for (let i = 0; i < 7; i += 1)
        nextLabels.push(await ctx.patient('checked_in'));
      const w1 = await ctx.patient('waiting');
      const w2 = await ctx.patient('waiting');

      await page.goto(`/waiting-room/${ctx.clinicId}/${ctx.sessionId}`);
      await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('tv-lead')).toHaveText(second.label);
      await expect(page.locator('.tv-other')).toHaveCount(0);
      await expect(page.getByTestId('tv-lead')).toBeVisible();
      await expect(page.locator('.tv-next li')).toHaveCount(5);
      await expect(page.locator('.tv-next li').first()).toHaveText(
        nextLabels[0]!.label,
      );
      await expect(page.locator('.tv-next')).toContainText(
        '+ 2 autres patients arrivés',
      );
      await expect(page.locator('.tv-next')).toContainText(
        '2 rendez-vous pas encore arrivés',
      );
      await expect(page.locator('.tv-called')).toContainText('تم النداء');
      await expect(page.locator('.tv-called')).toContainText('Appelé');
      // Waiting patients are counted, never listed.
      await expect(page.getByText(w1.label)).toHaveCount(0);
      await expect(page.getByText(w2.label)).toHaveCount(0);
      await expect(page.getByTestId('tv-banner')).toHaveCount(0);
      await expect(page.getByTestId('tv-stale')).toHaveCount(0);
      await expectNoLeak(
        page,
        [second.name, ...second.ids, ...w1.ids],
        [ctx.clinicId, ctx.sessionId],
      );
    });
  }

  test('shows none-called and empty states, and single-language modes', async ({
    page,
  }) => {
    const ctx = await seed(pool);
    await page.goto(`/waiting-room/${ctx.clinicId}/${ctx.sessionId}`);
    await expect(page.locator('.tv-called')).toContainText('لا يوجد نداء بعد');
    await expect(page.locator('.tv-called')).toContainText(
      "Pas encore d'appel",
    );
    await expect(page.locator('.tv-next li')).toHaveCount(0);
    const checked = await ctx.patient('checked_in');
    await page.goto(`/waiting-room/${ctx.clinicId}/${ctx.sessionId}?lang=fr`);
    await expect(page.locator('main')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('[lang="ar"]')).toHaveCount(0);
    await expect(page.locator('.tv-called')).toContainText(
      "Pas encore d'appel",
    );
    await expect(page.locator('.tv-next li')).toHaveText([checked.label]);
    await page.goto(`/waiting-room/${ctx.clinicId}/${ctx.sessionId}?lang=ar`);
    await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('[lang="fr"]')).toHaveCount(0);
  });

  test('shows several called tickets with the most recent large', async ({
    page,
  }) => {
    const ctx = await seed(pool);
    await page.clock.install();
    await page.goto(`/waiting-room/${ctx.clinicId}/${ctx.sessionId}`);
    await page.route(
      `**/api/public/clinics/${ctx.clinicId}/sessions/${ctx.sessionId}/waiting-room`,
      (route) =>
        route.fulfill({
          json: {
            session: { pauseStatus: 'active', declaredDelayMinutes: 0 },
            generatedAt: new Date().toISOString(),
            entries: [
              { publicDisplayLabel: 'Z-001', state: 'called', called: true },
              { publicDisplayLabel: 'Z-002', state: 'called', called: true },
            ],
          },
        }),
    );
    await page.clock.runFor(16_000);
    await expect(page.getByTestId('tv-lead')).toHaveText('Z-002');
    await expect(page.locator('.tv-other')).toHaveText(['Z-001']);
  });

  test('a stalled request is aborted and polling recovers', async ({
    page,
  }) => {
    const ctx = await seed(pool);
    await page.clock.install();
    await page.goto(`/waiting-room/${ctx.clinicId}/${ctx.sessionId}`);
    const api = `**/api/public/clinics/${ctx.clinicId}/sessions/${ctx.sessionId}/waiting-room`;
    let calls = 0;
    await page.route(api, (route) => {
      calls += 1;
      if (calls === 1) return; // never answers: stalls until the client aborts it
      return route.continue();
    });
    await page.clock.runFor(16_000); // first poll starts and stalls
    await expect.poll(() => calls).toBe(1);
    await page.clock.runFor(11_000); // the deadline aborts it
    await page.waitForTimeout(200);
    await page.clock.runFor(31_000); // backoff retry fires
    await expect.poll(() => calls).toBeGreaterThanOrEqual(2);
  });

  test('shows the paused banner and declared delay in both languages', async ({
    page,
  }) => {
    const ctx = await seed(pool);
    await pool.query(
      `UPDATE consultation_sessions SET status='paused', declared_delay_minutes=20, delay_updated_at=now() WHERE id=$1 AND clinic_id=$2`,
      [ctx.sessionId, ctx.clinicId],
    );
    await page.goto(`/waiting-room/${ctx.clinicId}/${ctx.sessionId}`);
    const banner = page.getByTestId('tv-banner');
    await expect(banner).toContainText('الجلسة متوقفة مؤقتًا');
    await expect(banner).toContainText('Séance en pause');
    await expect(banner).toContainText('تأخير معلن: 20 دقيقة');
    await expect(banner).toContainText('Retard annoncé : 20 min');
  });

  test('refreshes without reload, then shows the out-of-date overlay after 60 s of failures and recovers', async ({
    page,
  }) => {
    const ctx = await seed(pool);
    await page.clock.install();
    await page.goto(`/waiting-room/${ctx.clinicId}/${ctx.sessionId}`);
    await expect(page.locator('.tv-called')).toContainText('لا يوجد نداء بعد');

    // Live update through polling (no navigation).
    const called = await ctx.patient('called');
    await page.clock.runFor(16_000);
    await expect(page.getByTestId('tv-lead')).toHaveText(called.label);
    await expect(page.locator('.tv-indicator')).toHaveAttribute(
      'data-connection',
      'live',
    );

    // Simulated network failure.
    const api = `**/api/public/clinics/${ctx.clinicId}/sessions/${ctx.sessionId}/waiting-room`;
    await page.route(api, (route) => route.abort());
    await page.clock.runFor(30_000);
    await expect(page.getByTestId('tv-stale')).toHaveCount(0);
    await page.clock.runFor(35_000);
    const overlay = page.getByTestId('tv-stale');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Affichage non à jour depuis');
    await expect(overlay).toContainText('العرض غير محدَّث منذ');
    await expect(page.locator('.tv-indicator')).toHaveAttribute(
      'data-connection',
      'offline',
    );
    // Stale tickets are never rendered as current.
    await expect(page.getByText(called.label)).toHaveCount(0);

    // Recovery.
    await page.unroute(api);
    await page.clock.runFor(61_000);
    await expect(page.getByTestId('tv-stale')).toHaveCount(0);
    await expect(page.getByTestId('tv-lead')).toHaveText(called.label);
    await expect(page.locator('.tv-indicator')).toHaveAttribute(
      'data-connection',
      'live',
    );
  });
});
