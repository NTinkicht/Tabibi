import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';
import { GuestNotificationInboxService } from '@/modules/guest-notification-inbox';
import { InAppNotificationInboxRepository } from '@/modules/notification-inbox';
import type { RenderedNotificationDispatchEnvelope } from '@/modules/notification-domain';
import { migrate } from '../../scripts/db/lib';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const ids = {
  clinic: randomUUID(),
  actor: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  targetEntry: randomUUID(),
  foreignEntry: randomUUID(),
  targetPatient: randomUUID(),
  foreignPatient: randomUUID(),
};
const target = {
  clinicId: ids.clinic,
  sessionId: ids.session,
  queueEntryId: ids.targetEntry,
};

beforeAll(migrate);
beforeEach(async () => {
  await pool.query(`TRUNCATE guest_status_rate_limit_buckets,notification_inbox_items,
    guest_credentials,guest_exchange_ids,appointment_recovery_receipts,
    appointment_lifecycle_receipts,appointment_booking_receipts,appointments,
    audit_events,queue_command_receipts,queue_reorder_receipts,
    queue_registration_receipts,queue_entries,patient_operational_records,
    session_command_receipts,consultation_sessions,schedule_templates,
    doctor_clinics,doctor_profiles,clinic_memberships,clinics,users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
       ($1,'wu36-reception','Reception'),($2,'wu36-doctor','Doctor')`,
    [ids.actor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES($1,'wu36','WU36 Clinic')`,
    [ids.clinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role)
       VALUES($1,$2,'receptionist')`,
    [ids.clinic, ids.actor],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
       VALUES($1,$2,$3,'2026-09-13','2026-09-13T07:00Z','2026-09-13T12:00Z','open')`,
    [ids.session, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
       (id,clinic_id,private_display_name,contact_phone)
       VALUES($1,$3,'Target Guest','0555000036'),
             ($2,$3,'Foreign Guest','0555000037')`,
    [ids.targetPatient, ids.foreignPatient, ids.clinic],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,registration_order,public_display_label)
       VALUES($1,$3,$4,$5,'waiting','walk_in',1,'G-036'),
             ($2,$3,$4,$6,'waiting','walk_in',2,'G-037')`,
    [
      ids.targetEntry,
      ids.foreignEntry,
      ids.clinic,
      ids.session,
      ids.targetPatient,
      ids.foreignPatient,
    ],
  );
});
afterAll(() => pool.end());

function envelope(key: string): RenderedNotificationDispatchEnvelope {
  return {
    channel: 'in_app',
    locale: 'fr',
    direction: 'ltr',
    templateId: 'turn_approaching.v1',
    title: 'Votre tour approche',
    body: 'Il reste 2 passage(s) avant votre tour.',
    providerIdempotencyKey: key,
  };
}

async function liveBearer() {
  const access = new GuestAccessService(pool);
  const issuedAt = new Date();
  const issued = await access.issue(target, ids.actor, issuedAt);
  return access.consume(issued.exchangeId, target, issuedAt);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class PausingGuestAccessService extends GuestAccessService {
  constructor(
    testPool: Pool,
    private readonly entered: ReturnType<typeof deferred>,
    private readonly resume: Promise<void>,
  ) {
    super(testPool);
  }

  override async authorize(
    ...args: Parameters<GuestAccessService['authorize']>
  ): ReturnType<GuestAccessService['authorize']> {
    const authorized = await super.authorize(...args);
    this.entered.resolve();
    await this.resume;
    return authorized;
  }
}

async function expectStillBlocked(promise: Promise<unknown>) {
  const state = await Promise.race([
    promise.then(() => 'settled'),
    new Promise<'blocked'>((resolve) =>
      setTimeout(() => resolve('blocked'), 50),
    ),
  ]);
  expect(state).toBe('blocked');
}

describe('WU36 guest-bound notification inbox', () => {
  it('lists/counts only the patient behind the authorized queue entry and marks only that scope read', async () => {
    const credential = await liveBearer();
    const repository = new InAppNotificationInboxRepository(pool);
    const own = await repository.persist({
      clinicId: ids.clinic,
      subjectKind: 'visit_patient',
      subjectId: ids.targetPatient,
      envelope: envelope('wu36-own'),
    });
    const foreign = await repository.persist({
      clinicId: ids.clinic,
      subjectKind: 'visit_patient',
      subjectId: ids.foreignPatient,
      envelope: envelope('wu36-foreign'),
    });
    const service = new GuestNotificationInboxService(pool);

    await expect(
      service.getSnapshot(credential.bearer, 20),
    ).resolves.toMatchObject({
      items: [{ id: own.id, subjectId: ids.targetPatient, readAt: null }],
      unreadCount: 1,
    });
    await expect(
      service.markRead(credential.bearer, foreign.id),
    ).resolves.toBeNull();

    const firstRead = await service.markRead(credential.bearer, own.id);
    expect(firstRead?.readAt).not.toBeNull();
    const retry = await service.markRead(credential.bearer, own.id);
    expect(retry?.readAt).toBe(firstRead?.readAt);
    await expect(
      service.getSnapshot(credential.bearer, 20),
    ).resolves.toMatchObject({
      items: [{ id: own.id, readAt: firstRead?.readAt }],
      unreadCount: 0,
    });
  });

  it('rejects revoked, expired and terminal guest access without inbox mutation', async () => {
    const credential = await liveBearer();
    const repository = new InAppNotificationInboxRepository(pool);
    const own = await repository.persist({
      clinicId: ids.clinic,
      subjectKind: 'visit_patient',
      subjectId: ids.targetPatient,
      envelope: envelope('wu36-protected'),
    });
    const service = new GuestNotificationInboxService(pool);

    await pool.query(
      'UPDATE guest_credentials SET revoked_at=GREATEST(now(), issued_at)',
    );
    await expect(
      service.getSnapshot(credential.bearer, 20),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);

    await pool.query(
      `UPDATE guest_credentials
          SET revoked_at=NULL,
              issued_at=now() - interval '2 minutes',
              expires_at=now() - interval '1 minute'`,
    );
    await expect(
      service.markRead(credential.bearer, own.id),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);

    await pool.query(
      `UPDATE guest_credentials
          SET issued_at=now(), expires_at=now() + interval '1 hour'`,
    );
    await pool.query(
      "UPDATE queue_entries SET state='in_consultation' WHERE id=$1",
      [ids.targetEntry],
    );
    await pool.query("UPDATE queue_entries SET state='completed' WHERE id=$1", [
      ids.targetEntry,
    ]);
    await expect(
      service.getSnapshot(credential.bearer, 20),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);

    const stored = await repository.listForSubject({
      clinicId: ids.clinic,
      subjectKind: 'visit_patient',
      subjectId: ids.targetPatient,
      limit: 20,
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.readAt).toBeNull();
  });

  it('serializes credential revocation behind an authorized snapshot', async () => {
    const credential = await liveBearer();
    const repository = new InAppNotificationInboxRepository(pool);
    const own = await repository.persist({
      clinicId: ids.clinic,
      subjectKind: 'visit_patient',
      subjectId: ids.targetPatient,
      envelope: envelope('wu36-race-read'),
    });
    const entered = deferred();
    const resume = deferred();
    const service = new GuestNotificationInboxService(
      pool,
      new PausingGuestAccessService(pool, entered, resume.promise),
    );

    const snapshotPromise = service.getSnapshot(credential.bearer, 20);
    await entered.promise;
    const revokePromise = pool.query(
      'UPDATE guest_credentials SET revoked_at=GREATEST(now(), issued_at)',
    );
    await expectStillBlocked(revokePromise);

    resume.resolve();
    await expect(snapshotPromise).resolves.toMatchObject({
      items: [{ id: own.id }],
      unreadCount: 1,
    });
    await revokePromise;
    await expect(
      service.getSnapshot(credential.bearer, 20),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
  });

  it('serializes credential revocation behind an authorized mark-read', async () => {
    const credential = await liveBearer();
    const repository = new InAppNotificationInboxRepository(pool);
    const own = await repository.persist({
      clinicId: ids.clinic,
      subjectKind: 'visit_patient',
      subjectId: ids.targetPatient,
      envelope: envelope('wu36-race-read-state'),
    });
    const entered = deferred();
    const resume = deferred();
    const service = new GuestNotificationInboxService(
      pool,
      new PausingGuestAccessService(pool, entered, resume.promise),
    );

    const markPromise = service.markRead(credential.bearer, own.id);
    await entered.promise;
    const revokePromise = pool.query(
      'UPDATE guest_credentials SET revoked_at=GREATEST(now(), issued_at)',
    );
    await expectStillBlocked(revokePromise);

    resume.resolve();
    const marked = await markPromise;
    expect(marked?.readAt).not.toBeNull();
    await revokePromise;
    await expect(
      service.markRead(credential.bearer, own.id),
    ).rejects.toBeInstanceOf(GuestAccessRejectedError);
  });
});
