import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { AppointmentService } from '@/modules/appointment';
import { AppointmentLifecycleService } from '@/modules/appointment/lifecycle';
import { QueueNotificationProducer } from '@/modules/notification-domain';
import { NotificationOutboxRepository } from '@/modules/notification-outbox';
import { QueueService } from '@/modules/queue';
import { createStaffSessionToken } from '@/platform/http/staff-auth';

test('rehearses one bounded bilingual clinic day without tenant or patient leakage', async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const run = randomUUID();
  const ids = {
    clinic: randomUUID(),
    otherClinic: randomUUID(),
    receptionist: randomUUID(),
    otherReceptionist: randomUUID(),
    doctorUser: randomUUID(),
    otherDoctorUser: randomUUID(),
    doctor: randomUUID(),
    otherDoctor: randomUUID(),
    session: randomUUID(),
    otherSession: randomUUID(),
    scheduledPatient: randomUUID(),
  };
  const subject = `wu49-reception-${run}`;
  const otherSubject = `wu49-other-reception-${run}`;
  const scheduledPrivateName = `WU49 Scheduled Secret ${run}`;
  const walkInPrivateName = `WU49 Walkin Secret ${run}`;
  const noShowPrivateName = `WU49 No Show Secret ${run}`;
  const otherPrivateName = `WU49 Other Clinic Secret ${run}`;

  try {
    await pool.query(
      `INSERT INTO users(id,auth_subject,display_name) VALUES
        ($1,$5,'WU49 Reception'),
        ($2,$6,'WU49 Other Reception'),
        ($3,$7,'WU49 Doctor'),
        ($4,$8,'WU49 Other Doctor')`,
      [
        ids.receptionist,
        ids.otherReceptionist,
        ids.doctorUser,
        ids.otherDoctorUser,
        subject,
        otherSubject,
        `wu49-doctor-${run}`,
        `wu49-other-doctor-${run}`,
      ],
    );
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES
        ($1,$3,'WU49 Clinic'),
        ($2,$4,'WU49 Other Clinic')`,
      [
        ids.clinic,
        ids.otherClinic,
        `wu49-clinic-${run}`,
        `wu49-other-clinic-${run}`,
      ],
    );
    await pool.query(
      `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
        ($1,$3,'receptionist'),
        ($2,$4,'receptionist'),
        ($1,$5,'doctor'),
        ($2,$6,'doctor')`,
      [
        ids.clinic,
        ids.otherClinic,
        ids.receptionist,
        ids.otherReceptionist,
        ids.doctorUser,
        ids.otherDoctorUser,
      ],
    );
    await pool.query(
      `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES
        ($1,$3,'د. ليلى'),
        ($2,$4,'Dr Other Clinic')`,
      [ids.doctor, ids.otherDoctor, ids.doctorUser, ids.otherDoctorUser],
    );
    await pool.query(
      `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES
        ($1,$3),($2,$4)`,
      [ids.clinic, ids.otherClinic, ids.doctor, ids.otherDoctor],
    );

    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO consultation_sessions
        (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
       VALUES
        ($1,$3,$5,$7,$7::date+time '08:00',$7::date+time '18:00','open'),
        ($2,$4,$6,$7,$7::date+time '08:00',$7::date+time '18:00','open')`,
      [
        ids.session,
        ids.otherSession,
        ids.clinic,
        ids.otherClinic,
        ids.doctor,
        ids.otherDoctor,
        today,
      ],
    );
    await pool.query(
      `INSERT INTO patient_operational_records
        (id,clinic_id,private_display_name,preferred_locale)
       VALUES ($1,$2,$3,'ar')`,
      [ids.scheduledPatient, ids.clinic, scheduledPrivateName],
    );

    const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
    const otherScope = {
      clinicId: ids.otherClinic,
      actorUserId: ids.otherReceptionist,
    };
    const appointments = new AppointmentService(pool);
    const appointmentLifecycle = new AppointmentLifecycleService(pool);
    const queue = new QueueService(pool);
    const notificationProducer = new QueueNotificationProducer(
      new NotificationOutboxRepository(pool),
    );

    const scheduled = await appointments.bookForExistingPatient(
      scope,
      ids.session,
      {
        patientId: ids.scheduledPatient,
        scheduledStartAt: new Date(`${today}T09:00:00.000Z`),
        scheduledEndAt: new Date(`${today}T09:20:00.000Z`),
        contactPreference: 'none',
        idempotencyKey: `wu49-appointment-${run}`,
        correlationId: `wu49-appointment-${run}`,
      },
    );
    const walkIn = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: walkInPrivateName,
      preferredLocale: 'fr',
      idempotencyKey: `wu49-walkin-${run}`,
      correlationId: `wu49-walkin-${run}`,
    });
    const noShow = await queue.registerWalkIn(scope, ids.session, {
      privateDisplayName: noShowPrivateName,
      preferredLocale: 'ar',
      idempotencyKey: `wu49-noshow-${run}`,
      correlationId: `wu49-noshow-${run}`,
    });
    const other = await queue.registerWalkIn(otherScope, ids.otherSession, {
      privateDisplayName: otherPrivateName,
      preferredLocale: 'fr',
      idempotencyKey: `wu49-other-${run}`,
      correlationId: `wu49-other-${run}`,
    });

    await appointmentLifecycle.command(
      scope,
      ids.session,
      scheduled.appointment.id,
      {
        command: 'check_in',
        idempotencyKey: `wu49-scheduled-checkin-${run}`,
        correlationId: `wu49-scheduled-checkin-${run}`,
      },
    );
    await queue.command(scope, ids.session, walkIn.entry.id, {
      command: 'check_in',
      idempotencyKey: `wu49-walkin-checkin-${run}`,
      correlationId: `wu49-walkin-checkin-${run}`,
    });
    await queue.command(scope, ids.session, noShow.entry.id, {
      command: 'check_in',
      idempotencyKey: `wu49-noshow-checkin-${run}`,
      correlationId: `wu49-noshow-checkin-${run}`,
    });

    const initial = await queue.listOperational(scope, ids.session);
    expect(
      initial.entries
        .filter((entry) => entry.state === 'checked_in')
        .map((entry) => entry.id),
    ).toEqual([scheduled.entry.id, walkIn.entry.id, noShow.entry.id]);

    await notificationProducer.produce({
      clinicId: ids.clinic,
      queueEntryId: walkIn.entry.id,
      sourceEventId: `wu49-created-${run}`,
      sourceVersion: 1,
      notification: { eventKey: 'queue_entry_created', locale: 'fr' },
    });
    await notificationProducer.produce({
      clinicId: ids.clinic,
      queueEntryId: scheduled.entry.id,
      sourceEventId: `wu49-delay-${run}`,
      sourceVersion: 1,
      notification: {
        eventKey: 'estimate_changed_materially',
        locale: 'ar',
        windowStartMinutes: 20,
        windowEndMinutes: 35,
      },
    });

    await queue.command(scope, ids.session, scheduled.entry.id, {
      command: 'call',
      idempotencyKey: `wu49-scheduled-call-${run}`,
      correlationId: `wu49-scheduled-call-${run}`,
    });
    await notificationProducer.produce({
      clinicId: ids.clinic,
      queueEntryId: scheduled.entry.id,
      sourceEventId: `wu49-called-${run}`,
      sourceVersion: 1,
      notification: { eventKey: 'patient_called', locale: 'ar' },
    });
    await queue.command(scope, ids.session, scheduled.entry.id, {
      command: 'start_consultation',
      idempotencyKey: `wu49-scheduled-start-${run}`,
      correlationId: `wu49-scheduled-start-${run}`,
    });
    const completedScheduled = await appointmentLifecycle.command(
      scope,
      ids.session,
      scheduled.appointment.id,
      {
        command: 'complete_consultation',
        idempotencyKey: `wu49-scheduled-complete-${run}`,
        correlationId: `wu49-scheduled-complete-${run}`,
      },
    );
    expect(completedScheduled.appointment.status).toBe('completed');
    expect(completedScheduled.entry.state).toBe('completed');

    await queue.command(scope, ids.session, walkIn.entry.id, {
      command: 'call',
      idempotencyKey: `wu49-walkin-call-${run}`,
      correlationId: `wu49-walkin-call-${run}`,
    });
    await queue.command(scope, ids.session, walkIn.entry.id, {
      command: 'start_consultation',
      idempotencyKey: `wu49-walkin-start-${run}`,
      correlationId: `wu49-walkin-start-${run}`,
    });
    const completedWalkIn = await queue.command(
      scope,
      ids.session,
      walkIn.entry.id,
      {
        command: 'complete_consultation',
        idempotencyKey: `wu49-walkin-complete-${run}`,
        correlationId: `wu49-walkin-complete-${run}`,
      },
    );
    expect(completedWalkIn.state).toBe('completed');

    const noShowResult = await queue.command(
      scope,
      ids.session,
      noShow.entry.id,
      {
        command: 'no_show',
        reason: 'bounded acceptance rehearsal',
        idempotencyKey: `wu49-noshow-command-${run}`,
        correlationId: `wu49-noshow-command-${run}`,
      },
    );
    expect(noShowResult.state).toBe('no_show');

    const finalOperational = await queue.listOperational(scope, ids.session);
    expect(
      finalOperational.entries.map(({ id, state }) => ({ id, state })),
    ).toEqual(
      expect.arrayContaining([
        { id: scheduled.entry.id, state: 'completed' },
        { id: walkIn.entry.id, state: 'completed' },
        { id: noShow.entry.id, state: 'no_show' },
      ]),
    );

    const notifications = await pool.query<{
      clinic_id: string;
      queue_entry_id: string | null;
      event_key: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT clinic_id,queue_entry_id,event_key,payload
         FROM notification_outbox
        WHERE clinic_id=$1 AND queue_entry_id=ANY($2::uuid[])
        ORDER BY created_at,id`,
      [ids.clinic, [scheduled.entry.id, walkIn.entry.id]],
    );
    expect(notifications.rows.map((row) => row.event_key)).toEqual([
      'queue_entry_created',
      'estimate_changed_materially',
      'patient_called',
    ]);
    expect(
      notifications.rows.every((row) => row.clinic_id === ids.clinic),
    ).toBe(true);
    expect(JSON.stringify(notifications.rows)).not.toContain(
      scheduledPrivateName,
    );
    expect(JSON.stringify(notifications.rows)).not.toContain(walkInPrivateName);
    expect(JSON.stringify(notifications.rows)).not.toContain(otherPrivateName);

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
      `/operations/${ids.clinic}/sessions/${ids.session}/queue?locale=ar`,
    );
    const main = page.locator('main');
    await expect(main).toHaveAttribute('dir', 'rtl');
    await expect(
      page.getByRole('heading', { name: 'قائمة المرضى بدون موعد' }),
    ).toBeVisible();

    const frenchButton = page.getByRole('button', { name: 'Français' });
    await frenchButton.focus();
    await expect(frenchButton).toBeFocused();
    await frenchButton.press('Enter');
    await expect(main).toHaveAttribute('dir', 'ltr');
    await expect(
      page.getByRole('heading', { name: 'File des patients sans rendez-vous' }),
    ).toBeVisible();

    await page.goto(`/waiting-room/${ids.clinic}/${ids.session}`);
    await expect(page.locator('main')).toHaveAttribute('dir', 'rtl');
    const publicBody = await page.locator('body').innerText();
    for (const hidden of [
      scheduledPrivateName,
      walkInPrivateName,
      noShowPrivateName,
      otherPrivateName,
      ids.otherClinic,
      ids.otherSession,
      scheduled.appointment.patientId,
      scheduled.entry.id,
      walkIn.patient.id,
      walkIn.entry.id,
      noShow.patient.id,
      noShow.entry.id,
      other.patient.id,
      other.entry.id,
    ]) {
      expect(publicBody).not.toContain(hidden);
    }

    await page.goto(`/waiting-room/${ids.clinic}/${ids.session}?lang=fr`);
    await expect(page.locator('main')).toHaveAttribute('dir', 'ltr');
    await expect(
      page.getByRole('heading', { name: "Salle d'attente" }),
    ).toBeVisible();
    const frenchPublicBody = await page.locator('body').innerText();
    expect(frenchPublicBody).not.toContain(otherPrivateName);
    expect(frenchPublicBody).not.toContain(ids.otherClinic);
  } finally {
    await pool.end();
  }
});
