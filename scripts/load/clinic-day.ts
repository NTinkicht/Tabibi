import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { migrate } from '../db/lib';
import { QueueNotificationProducer } from '../../src/modules/notification-domain';
import { createQueueInAppNotificationDispatchService } from '../../src/modules/notification-domain/in-app-runtime';
import { NotificationOutboxRepository } from '../../src/modules/notification-outbox';
import { NotificationPreferenceRepository } from '../../src/modules/notification-preferences';
import { QueueService } from '../../src/modules/queue';
import {
  assertLoadRehearsalAllowed,
  assertLoadThresholds,
  deterministicRunKey,
  deterministicUuid,
  loadConfig,
  type LoadSample,
  runBounded,
  safeErrorDiagnostic,
  summarizeLoad,
} from './clinic-day-lib';

interface RegistrationResult {
  entry: { id: string; registrationOrder: number };
  patient: { id: string };
}

function executionNamespace(seed: string): string {
  return deterministicRunKey(`${seed}:${Date.now()}:${process.pid}`);
}

async function setupSyntheticClinic(
  pool: Pool,
  seed: string,
  namespace: string,
): Promise<{
  clinicId: string;
  receptionistId: string;
  sessionId: string;
}> {
  const clinicId = deterministicUuid(seed, `${namespace}:clinic`);
  const receptionistId = deterministicUuid(seed, `${namespace}:receptionist`);
  const doctorUserId = deterministicUuid(seed, `${namespace}:doctor-user`);
  const doctorId = deterministicUuid(seed, `${namespace}:doctor`);
  const sessionId = deterministicUuid(seed, `${namespace}:session`);

  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
      ($1, $3, 'Synthetic Load Reception'),
      ($2, $4, 'Synthetic Load Doctor')`,
    [
      receptionistId,
      doctorUserId,
      `wu43-reception-${namespace}`,
      `wu43-doctor-${namespace}`,
    ],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name)
     VALUES ($1, $2, 'WU43 Synthetic Load Clinic')`,
    [clinicId, `wu43-${namespace}`],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES
      ($1, $2, 'receptionist'),
      ($1, $3, 'doctor')`,
    [clinicId, receptionistId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name)
     VALUES ($1, $2, 'Synthetic Load Doctor')`,
    [doctorId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES
      ($1, $2, $3, CURRENT_DATE,
       CURRENT_DATE + time '08:00', CURRENT_DATE + time '18:00', 'open')`,
    [sessionId, clinicId, doctorId],
  );

  return { clinicId, receptionistId, sessionId };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  assertLoadRehearsalAllowed(process.env, databaseUrl);
  const config = loadConfig(process.env);
  await migrate();

  const namespace = executionNamespace(config.seed);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Math.max(8, config.concurrency + 4),
  });
  const samples: LoadSample[] = [];

  const timed = async <T>(
    phase: LoadSample['phase'],
    operation: string,
    work: () => Promise<T>,
  ): Promise<T | undefined> => {
    const started = performance.now();
    try {
      const value = await work();
      samples.push({
        phase,
        operation,
        ok: true,
        durationMs: performance.now() - started,
      });
      return value;
    } catch (error) {
      samples.push({
        phase,
        operation,
        ok: false,
        durationMs: performance.now() - started,
      });
      console.error(
        `Load operation failed [${phase}/${operation}]: ${safeErrorDiagnostic(error)}`,
      );
      return undefined;
    }
  };

  try {
    const synthetic = await setupSyntheticClinic(pool, config.seed, namespace);
    const scope = {
      clinicId: synthetic.clinicId,
      actorUserId: synthetic.receptionistId,
    };
    const queue = new QueueService(pool);
    const outbox = new NotificationOutboxRepository(pool);
    const producer = new QueueNotificationProducer(outbox);
    const preferences = new NotificationPreferenceRepository(pool);
    const inAppDispatch = createQueueInAppNotificationDispatchService(pool);

    const workloadStarted = Date.now();
    const deadline = workloadStarted + config.maxDurationMs;
    const clinicRegistrations = new Array<RegistrationResult | undefined>(
      config.clinicDayPatients,
    );
    const clinicIndexes = Array.from(
      { length: config.clinicDayPatients },
      (_, index) => index,
    );

    await runBounded(
      clinicIndexes,
      config.concurrency,
      deadline,
      async (index) => {
        clinicRegistrations[index] = await timed(
          'clinic_day',
          'register_walk_in',
          () =>
            queue.registerWalkIn(scope, synthetic.sessionId, {
              privateDisplayName: `Synthetic Clinic Day ${index + 1}`,
              preferredLocale: index % 2 === 0 ? 'ar' : 'fr',
              idempotencyKey: `wu43-day-register-${namespace}-${index}`,
              correlationId: `wu43-day-${index}`,
            }),
        );
      },
    );

    const successfulClinicRegistrations = clinicRegistrations.filter(
      (registration): registration is RegistrationResult =>
        registration !== undefined,
    );

    const readIndexes = Array.from(
      { length: Math.max(4, Math.min(config.clinicDayPatients, 12)) },
      (_, index) => index,
    );
    await runBounded(readIndexes, config.concurrency, deadline, async () => {
      await timed('clinic_day', 'list_waiting', () =>
        queue.listWaiting(scope, synthetic.sessionId),
      );
    });

    await runBounded(
      successfulClinicRegistrations,
      config.concurrency,
      deadline,
      async (registration, index) => {
        await timed('clinic_day', 'check_in', () =>
          queue.command(scope, synthetic.sessionId, registration.entry.id, {
            command: 'check_in',
            idempotencyKey: `wu43-day-checkin-${namespace}-${index}`,
            correlationId: `wu43-day-checkin-${index}`,
          }),
        );
      },
    );

    const operational = await timed('clinic_day', 'list_operational', () =>
      queue.listOperational(scope, synthetic.sessionId),
    );
    const progressCandidates =
      operational?.entries
        .filter((entry) => entry.state === 'checked_in')
        .slice(0, 4) ?? [];

    for (const [index, registration] of progressCandidates.entries()) {
      if (Date.now() > deadline) {
        throw new Error('Load rehearsal exceeded wall-clock deadline');
      }
      const call = await timed('clinic_day', 'call_patient', () =>
        queue.command(scope, synthetic.sessionId, registration.id, {
          command: 'call',
          idempotencyKey: `wu43-day-call-${namespace}-${index}`,
          correlationId: `wu43-day-call-${index}`,
        }),
      );
      if (!call) continue;
      const started = await timed('clinic_day', 'start_consultation', () =>
        queue.command(scope, synthetic.sessionId, registration.id, {
          command: 'start_consultation',
          idempotencyKey: `wu43-day-start-${namespace}-${index}`,
          correlationId: `wu43-day-start-${index}`,
        }),
      );
      if (!started) continue;
      await timed('clinic_day', 'complete_consultation', () =>
        queue.command(scope, synthetic.sessionId, registration.id, {
          command: 'complete_consultation',
          idempotencyKey: `wu43-day-complete-${namespace}-${index}`,
          correlationId: `wu43-day-complete-${index}`,
        }),
      );
    }

    const burstRegistrations = new Array<RegistrationResult | undefined>(
      config.burstPatients,
    );
    const burstIndexes = Array.from(
      { length: config.burstPatients },
      (_, index) => index,
    );
    await runBounded(
      burstIndexes,
      config.concurrency,
      deadline,
      async (index) => {
        burstRegistrations[index] = await timed(
          'burst',
          'register_walk_in',
          () =>
            queue.registerWalkIn(scope, synthetic.sessionId, {
              privateDisplayName: `Synthetic Burst ${index + 1}`,
              preferredLocale: index % 2 === 0 ? 'fr' : 'ar',
              idempotencyKey: `wu43-burst-register-${namespace}-${index}`,
              correlationId: `wu43-burst-${index}`,
            }),
        );
      },
    );

    const successfulBurstRegistrations = burstRegistrations.filter(
      (registration): registration is RegistrationResult =>
        registration !== undefined,
    );

    await runBounded(
      successfulBurstRegistrations,
      config.concurrency,
      deadline,
      async (registration, index) => {
        const preference = await timed('burst', 'enable_in_app', () =>
          preferences.change({
            clinicId: synthetic.clinicId,
            subjectKind: 'visit_patient',
            subjectId: registration.patient.id,
            channel: 'in_app',
            preferenceState: 'enabled',
            consentState: 'not_required',
            idempotencyKey: `wu43-burst-pref-${namespace}-${index}`,
          }),
        );
        if (!preference) return;

        const intent = await timed('burst', 'produce_notification', () =>
          producer.produce({
            clinicId: synthetic.clinicId,
            queueEntryId: registration.entry.id,
            sourceEventId: `wu43-burst-event-${namespace}-${index}`,
            sourceVersion: 1,
            notification: {
              eventKey: 'queue_entry_created',
              locale: index % 2 === 0 ? 'fr' : 'ar',
            },
          }),
        );
        if (!intent) return;

        const delivered = await timed('burst', 'dispatch_in_app', () =>
          inAppDispatch.dispatchOne({
            clinicId: synthetic.clinicId,
            intentId: intent.id,
          }),
        );
        if (!delivered) return;

        await timed('burst', 'check_in', () =>
          queue.command(scope, synthetic.sessionId, registration.entry.id, {
            command: 'check_in',
            idempotencyKey: `wu43-burst-checkin-${namespace}-${index}`,
            correlationId: `wu43-burst-checkin-${index}`,
          }),
        );
      },
    );

    await runBounded(burstIndexes, config.concurrency, deadline, async () => {
      await timed('burst', 'list_waiting', () =>
        queue.listWaiting(scope, synthetic.sessionId),
      );
    });

    const durationMs = Date.now() - workloadStarted;
    const summary = summarizeLoad(samples, durationMs);
    process.stdout.write(
      `${JSON.stringify({
        kind: 'tabibi_clinic_day_load_summary',
        seed: config.seed,
        clinicDayPatients: config.clinicDayPatients,
        burstPatients: config.burstPatients,
        concurrency: config.concurrency,
        summary,
      })}\n`,
    );
    assertLoadThresholds(summary, config);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : 'unknown load rehearsal error';
  console.error(`Clinic-day load rehearsal failed: ${message}`);
  process.exitCode = 1;
});
