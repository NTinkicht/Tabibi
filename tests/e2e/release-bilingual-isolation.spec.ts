import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { QueueService } from '@/modules/queue';

test(
  'release scenario keeps Arabic and French public queues clinic-isolated',
  async ({ page }) => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const ids = {
      clinicA: randomUUID(),
      clinicB: randomUUID(),
      receptionistA: randomUUID(),
      receptionistB: randomUUID(),
      doctorUserA: randomUUID(),
      doctorUserB: randomUUID(),
      doctorA: randomUUID(),
      doctorB: randomUUID(),
      sessionA: randomUUID(),
      sessionB: randomUUID(),
    };
    const privateNameA = 'Release Arabic Secret';
    const privateNameB = 'Release French Secret';

    try {
      await pool.query(
        `INSERT INTO users(id,auth_subject,display_name) VALUES
        ($1,'release-browser-reception-a','Reception A'),
        ($2,'release-browser-reception-b','Reception B'),
        ($3,'release-browser-doctor-a','Doctor A'),
        ($4,'release-browser-doctor-b','Doctor B')`,
        [
          ids.receptionistA,
          ids.receptionistB,
          ids.doctorUserA,
          ids.doctorUserB,
        ],
      );
      await pool.query(
        `INSERT INTO clinics(id,tenant_key,name) VALUES
        ($1,'release-browser-clinic-a','Release Clinic A'),
        ($2,'release-browser-clinic-b','Release Clinic B')`,
        [ids.clinicA, ids.clinicB],
      );
      await pool.query(
        `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
        ($1,$3,'receptionist'),
        ($2,$4,'receptionist'),
        ($1,$5,'doctor'),
        ($2,$6,'doctor')`,
        [
          ids.clinicA,
          ids.clinicB,
          ids.receptionistA,
          ids.receptionistB,
          ids.doctorUserA,
          ids.doctorUserB,
        ],
      );
      await pool.query(
        `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES
        ($1,$3,'Release Doctor A'),
        ($2,$4,'Release Doctor B')`,
        [ids.doctorA, ids.doctorB, ids.doctorUserA, ids.doctorUserB],
      );
      await pool.query(
        `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES
        ($1,$3),($2,$4)`,
        [ids.clinicA, ids.clinicB, ids.doctorA, ids.doctorB],
      );
      const today = new Date().toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO consultation_sessions
        (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
       VALUES
        ($1,$3,$5,$7,$7::date+time '09:00',$7::date+time '12:00','open'),
        ($2,$4,$6,$7,$7::date+time '09:00',$7::date+time '12:00','open')`,
        [
          ids.sessionA,
          ids.sessionB,
          ids.clinicA,
          ids.clinicB,
          ids.doctorA,
          ids.doctorB,
          today,
        ],
      );

      const queue = new QueueService(pool);
      const registrationA = await queue.registerWalkIn(
        { clinicId: ids.clinicA, actorUserId: ids.receptionistA },
        ids.sessionA,
        {
          privateDisplayName: privateNameA,
          preferredLocale: 'ar',
          idempotencyKey: 'release-browser-ar-register',
          correlationId: 'release-browser-ar-register',
        },
      );
      const registrationB = await queue.registerWalkIn(
        { clinicId: ids.clinicB, actorUserId: ids.receptionistB },
        ids.sessionB,
        {
          privateDisplayName: privateNameB,
          preferredLocale: 'fr',
          idempotencyKey: 'release-browser-fr-register',
          correlationId: 'release-browser-fr-register',
        },
      );

      await page.goto(`/waiting-room/${ids.clinicA}/${ids.sessionA}`);
      await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
      await expect(
        page.getByRole('heading', { name: 'قاعة الانتظار' }),
      ).toBeVisible();
      await expect(
        page.getByText(registrationA.entry.publicDisplayLabel),
      ).toBeVisible();
      await expect(
        page.getByText(registrationB.entry.publicDisplayLabel),
      ).toHaveCount(0);
      const arabicBody = await page.locator('body').innerText();
      for (const hidden of [
        privateNameA,
        privateNameB,
        registrationA.patient.id,
        registrationA.entry.id,
        registrationB.patient.id,
      ]) {
        expect(arabicBody).not.toContain(hidden);
      }

      await page.goto(`/waiting-room/${ids.clinicB}/${ids.sessionB}?lang=fr`);
      await expect(page.locator('main')).toHaveAttribute('dir', 'ltr');
      await expect(
        page.getByRole('heading', { name: "Salle d'attente" }),
      ).toBeVisible();
      await expect(
        page.getByText(registrationB.entry.publicDisplayLabel),
      ).toBeVisible();
      await expect(
        page.getByText(registrationA.entry.publicDisplayLabel),
      ).toHaveCount(0);
      const frenchBody = await page.locator('body').innerText();
      for (const hidden of [
        privateNameA,
        privateNameB,
        registrationB.patient.id,
        registrationB.entry.id,
        registrationA.patient.id,
      ]) {
        expect(frenchBody).not.toContain(hidden);
      }
    } finally {
      await pool.end();
    }
  },
);
