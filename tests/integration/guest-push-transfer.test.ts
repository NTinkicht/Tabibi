import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { GuestPushSubscriptionStore } from '@/modules/guest-push/subscription-store';
import { PushSubscriptionSealer } from '@/modules/guest-push/subscription-seal';
import { QueueService } from '@/modules/queue';
import { QueueTransferService } from '@/modules/queue/transfer';
import { migrate } from '../../scripts/db/lib';

// docs/design/pwa-push.md section 3 (#894): push bindings move with a staff
// transfer, atomically, and a push-only guest receives a working transfer link.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctorRole: randomUUID(),
  outsider: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  closed: randomUUID(),
  target: randomUUID(),
  otherDoctor: randomUUID(),
  otherDoctorSession: randomUUID(),
  otherDoctorUser: randomUUID(),
  patient: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
let seq = 0;
const key = () => `qr-${++seq}`;
const queue = () => new QueueService(pool);
const ENVELOPE_SECRET = 'x'.repeat(48);
const sealer = new PushSubscriptionSealer('s'.repeat(48));
const store = new GuestPushSubscriptionStore(pool, sealer);
const transferSvc = (withSealer = true) =>
  new QueueTransferService(
    pool,
    new GuestLinkEnvelope(ENVELOPE_SECRET),
    withSealer ? sealer : undefined,
  );

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE appointment_recovery_receipts,
    appointment_lifecycle_receipts, appointment_booking_receipts, appointments,
    audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'qr-reception','Reception'),($2,'qr-doctor','Doctor'),
      ($3,'qr-doctor-role','Doctor Role'),($4,'qr-outsider','Outsider')`,
    [ids.receptionist, ids.doctorUser, ids.doctorRole, ids.outsider],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
      ($1,'qr-a','QR Clinic'),($2,'qr-b','QR Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
      ($1,$2,'receptionist'),($1,$3,'doctor'),($4,$5,'clinic_admin')`,
    [
      ids.clinic,
      ids.receptionist,
      ids.doctorRole,
      ids.otherClinic,
      ids.outsider,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr QR')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES
      ($1,$3,$4,'2026-09-18','2026-09-18 09:00Z','2026-09-18 12:00Z','open'),
      ($2,$3,$4,'2026-09-19','2026-09-19 09:00Z','2026-09-19 12:00Z','closed')`,
    [ids.session, ids.closed, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES ($1,$2,$3,'2026-09-20','2026-09-20 09:00Z','2026-09-20 12:00Z','planned')`,
    [ids.target, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'qr-doctor2','Doctor 2')`,
    [ids.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr Two')`,
    [ids.otherDoctor, ids.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.otherDoctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES ($1,$2,$3,'2026-09-18','2026-09-18 13:00Z','2026-09-18 15:00Z','open')`,
    [ids.otherDoctorSession, ids.clinic, ids.otherDoctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,private_display_name,preferred_locale)
      VALUES($1,$2,'QR Patient','fr')`,
    [ids.patient, ids.clinic],
  );
});
afterAll(async () => pool.end());

async function walkIn(name: string, contactPhone?: string) {
  const item = await queue().registerWalkIn(scope, ids.session, {
    privateDisplayName: name,
    contactPhone,
    preferredLocale: 'ar',
    idempotencyKey: key(),
    correlationId: 'qr-register',
  });
  return item.entry.id;
}
async function cmd(
  entryId: string,
  command: Parameters<QueueService['command']>[3]['command'],
) {
  return queue().command(scope, ids.session, entryId, {
    command,
    reason: 'because',
    cancellationSource: command === 'cancel' ? 'clinic' : undefined,
    idempotencyKey: key(),
    correlationId: 'qr-cmd',
  });
}
function transfer(
  entryId: string,
  targetSessionId = ids.target,
  idempotencyKey = key(),
  sessionId = ids.session,
  withSealer = true,
) {
  return transferSvc(withSealer).transfer(scope, sessionId, entryId, {
    targetSessionId,
    reason: 'Doctor moved the consultation',
    idempotencyKey,
    correlationId: 'qr-transfer',
  });
}
const versionOf = async (id: string) =>
  Number(
    (
      await pool.query<{ v: string }>(
        'SELECT queue_order_version v FROM consultation_sessions WHERE id=$1',
        [id],
      )
    ).rows[0]!.v,
  );
const stateOf = async (id: string) =>
  (
    await pool.query<{ state: string }>(
      'SELECT state FROM queue_entries WHERE id=$1',
      [id],
    )
  ).rows[0]!.state;

const material = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/transfer-token-${n}`,
  keys: { p256dh: `BTransferPub_${n}`, auth: `transferAuth_${n}` },
});
const bindings = async (entryId: string) =>
  (
    await pool.query<{
      id: string;
      sealed_subscription: string | null;
      revoked_at: Date | null;
      revocation_reason: string | null;
      expires_at: Date;
      endpoint_hash: string;
    }>(
      `SELECT id, sealed_subscription, revoked_at, revocation_reason, expires_at, endpoint_hash
         FROM guest_push_subscriptions WHERE queue_entry_id=$1 ORDER BY created_at`,
      [entryId],
    )
  ).rows;
const pushIntents = async (entryId: string) =>
  (
    await pool.query<{ contact_kind: string; intent: string; state: string }>(
      `SELECT x.contact_kind, i.intent, i.state
         FROM guest_link_intents i
         JOIN guest_exchange_ids x ON x.queue_entry_id=i.queue_entry_id
        WHERE i.queue_entry_id=$1`,
      [entryId],
    )
  ).rows;

describe('push bindings on queue transfer (#894)', () => {
  it('moves the binding re-sealed to the target and issues a push transfer link to a push-only guest', async () => {
    const a = await walkIn('A');
    const { subscriptionId } = await store.subscribe(
      { clinicId: ids.clinic, queueEntryId: a },
      material(1),
      'fr',
    );
    const before = (await bindings(a))[0]!;
    const result = await transfer(a);
    const targetId = result.target.id;

    const source = (await bindings(a))[0]!;
    expect(source.id).toBe(subscriptionId);
    expect(source.revoked_at).not.toBeNull();
    expect(source.revocation_reason).toBe('terminal');
    expect(source.sealed_subscription).toBeNull();

    const moved = await bindings(targetId);
    expect(moved).toHaveLength(1);
    const active = moved[0]!;
    expect(active.revoked_at).toBeNull();
    expect(active.endpoint_hash).toBe(before.endpoint_hash);
    expect(active.expires_at.getTime()).toBe(before.expires_at.getTime());
    // Sealed under the target AAD: opens only as the target, never as the source.
    expect(
      sealer.open(
        { clinicId: ids.clinic, queueEntryId: targetId, id: active.id },
        active.sealed_subscription!,
      ),
    ).toMatchObject({ endpoint: material(1).endpoint });
    expect(() =>
      sealer.open(
        { clinicId: ids.clinic, queueEntryId: a, id: active.id },
        active.sealed_subscription!,
      ),
    ).toThrow();

    // No phone or email, yet the target gets one push exchange and transfer intent.
    expect(await pushIntents(targetId)).toEqual([
      { contact_kind: 'push', intent: 'transfer', state: 'pending' },
    ]);
    const exchange = await pool.query<{ id: string }>(
      `SELECT id FROM guest_exchange_ids WHERE queue_entry_id=$1 AND consumed_at IS NULL`,
      [targetId],
    );
    expect(exchange.rowCount).toBe(1);
    // The source keeps no live exchange, intent or binding.
    expect(
      (await bindings(a)).filter((row) => row.revoked_at === null),
    ).toHaveLength(0);
    expect(await pushIntents(a)).toEqual([]);
  });

  it('prefers the push exchange over the staff contact path and mints exactly one link', async () => {
    const a = await walkIn('A', '+213555000777');
    await store.subscribe(
      { clinicId: ids.clinic, queueEntryId: a },
      material(2),
      'ar',
    );
    const targetId = (await transfer(a)).target.id;
    expect(await pushIntents(targetId)).toEqual([
      { contact_kind: 'push', intent: 'transfer', state: 'pending' },
    ]);
  });

  it('drops the binding and issues nothing when no sealer is configured (fail closed)', async () => {
    const a = await walkIn('A');
    await store.subscribe(
      { clinicId: ids.clinic, queueEntryId: a },
      material(3),
      'fr',
    );
    const targetId = (await transfer(a, ids.target, key(), ids.session, false))
      .target.id;
    expect((await bindings(a))[0]!.revocation_reason).toBe('terminal');
    expect((await bindings(a))[0]!.sealed_subscription).toBeNull();
    expect(await bindings(targetId)).toEqual([]);
    expect(await pushIntents(targetId)).toEqual([]);
  });

  it('does not move an expired binding', async () => {
    const a = await walkIn('A');
    await store.subscribe(
      { clinicId: ids.clinic, queueEntryId: a },
      material(4),
      'fr',
      new Date(Date.now() - 25 * 60 * 60 * 1000),
    );
    const targetId = (await transfer(a)).target.id;
    expect((await bindings(a))[0]!.revocation_reason).toBe('expired');
    expect(await bindings(targetId)).toEqual([]);
    expect(await pushIntents(targetId)).toEqual([]);
  });

  it('replays idempotently without a second binding or link, ', async () => {
    const a = await walkIn('A');
    await store.subscribe(
      { clinicId: ids.clinic, queueEntryId: a },
      material(5),
      'fr',
    );
    const idem = key();
    const first = await transfer(a, ids.target, idem);
    const second = await transfer(a, ids.target, idem);
    expect(second.target.id).toBe(first.target.id);
    expect(await bindings(first.target.id)).toHaveLength(1);
    expect(await pushIntents(first.target.id)).toHaveLength(1);
  });

  it("leaves another guest's binding untouched", async () => {
    const a = await walkIn('A');
    const b = await walkIn('B');
    await store.subscribe(
      { clinicId: ids.clinic, queueEntryId: a },
      material(6),
      'fr',
    );
    await store.subscribe(
      { clinicId: ids.clinic, queueEntryId: b },
      material(7),
      'fr',
    );
    await transfer(a);
    const other = await bindings(b);
    expect(other).toHaveLength(1);
    expect(other[0]!.revoked_at).toBeNull();
  });
});
