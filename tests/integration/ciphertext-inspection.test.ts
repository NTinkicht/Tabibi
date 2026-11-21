import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { inspectCiphertextAtRest } from '../../scripts/db/ciphertext-inspection-lib';
import { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { GuestLinkIntentStore } from '@/modules/guest-access/link-intents';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import {
  PublicGuestBookingService,
  scrubExpiredBookingReceipts,
} from '@/modules/public-guest-booking';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const now = new Date('2099-02-01T00:00:00.000Z');
const MATERIAL = 'plaintext-exchange-link-material-ci1';

beforeAll(async () => migrate());
afterAll(async () => pool.end());
beforeEach(async () => {
  await pool.query(`TRUNCATE guest_link_intents, public_guest_booking_receipts,
    guest_credentials, guest_exchange_ids, audit_events, queue_reorder_receipts,
    queue_command_receipts, queue_registration_receipts, appointments,
    appointment_booking_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
});

async function bookOne() {
  const clinicId = randomUUID();
  const doctorId = randomUUID();
  const doctorUserId = randomUUID();
  const sessionId = randomUUID();
  const startsAt = '2099-03-01T08:00:00.000Z';
  const endsAt = '2099-03-01T09:00:00.000Z';
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, 'Doc')`,
    [doctorUserId, `ci-doctor-${doctorUserId}`],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name, status) VALUES ($1, $2, 'Clinic', 'active')`,
    [clinicId, `ci-clinic-${clinicId}`],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, 'Doc')`,
    [doctorId, doctorUserId],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id, clinic_id, doctor_id, service_date, starts_at, ends_at, status)
     VALUES ($1, $2, $3, '2099-03-01', $4, $5, 'planned')`,
    [sessionId, clinicId, doctorId, startsAt, endsAt],
  );
  const selections = new PublicAvailabilitySelectionService(
    pool,
    'ci-selection-secret-that-is-deliberately-long-enough',
    () => now,
    60_000,
  );
  const reference = await selections.issue({
    clinicId,
    doctorId,
    sessionId,
    startsAt,
    endsAt,
  });
  if (!reference) throw new Error('selection reference not issued');
  await new PublicGuestBookingService(pool, selections, () => now).book({
    selectionReference: reference,
    privateDisplayName: 'Private Guest Name',
    contactPhone: '+213555010101',
    contactEmail: 'guest@example.com',
    preferredLocale: 'fr',
    contactPreference: 'phone',
    idempotencyKey: 'ci-inspect-1',
    correlationId: 'ci-correlation-1',
  });
  const entry = await pool.query<{ id: string }>(
    'SELECT id FROM queue_entries WHERE clinic_id = $1',
    [clinicId],
  );
  return { clinicId, queueEntryId: entry.rows[0]!.id };
}

describe('release-time ciphertext-at-rest inspection (TAB-P0-15)', () => {
  it('reports a clean database and counts live ciphertext without leaking it', async () => {
    const { clinicId, queueEntryId } = await bookOne();
    const store = new GuestLinkIntentStore(
      pool,
      new GuestLinkEnvelope('x'.repeat(48), () => now),
      () => now,
    );
    await store.create({
      clinicId,
      queueEntryId,
      intent: 'initial',
      material: MATERIAL,
      exchangeExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    const report = await inspectCiphertextAtRest(pool, now);
    expect(report).toMatchObject({
      clean: true,
      guestLinkIntents: { pendingWithCiphertext: 1, pendingPastExpiry: 0 },
      bookingReceipts: { withCiphertext: 1, unscrubbedAfterCredentialDead: 0 },
    });
    expect(JSON.stringify(report)).not.toContain(MATERIAL);
  });

  it('flags replay ciphertext that outlived its dead credential until the scrub runs', async () => {
    await bookOne();
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const dirty = await inspectCiphertextAtRest(pool, later);
    expect(dirty.clean).toBe(false);
    expect(dirty.bookingReceipts.unscrubbedAfterCredentialDead).toBe(1);
    expect(await scrubExpiredBookingReceipts(pool, later)).toBe(1);
    const scrubbed = await inspectCiphertextAtRest(pool, later);
    expect(scrubbed.clean).toBe(true);
    expect(scrubbed.bookingReceipts.withCiphertext).toBe(0);
  });

  it('flags a pending intent whose ciphertext outlived its expiry', async () => {
    const { clinicId, queueEntryId } = await bookOne();
    const store = new GuestLinkIntentStore(
      pool,
      new GuestLinkEnvelope('x'.repeat(48), () => now),
      () => now,
    );
    await store.create({
      clinicId,
      queueEntryId,
      intent: 'initial',
      material: MATERIAL,
      exchangeExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    const report = await inspectCiphertextAtRest(
      pool,
      new Date(now.getTime() + 6 * 60 * 1000),
    );
    expect(report.clean).toBe(false);
    expect(report.guestLinkIntents.pendingPastExpiry).toBe(1);
  });

  it('flags plaintext stored where an envelope is required', async () => {
    const { clinicId, queueEntryId } = await bookOne();
    const store = new GuestLinkIntentStore(
      pool,
      new GuestLinkEnvelope('x'.repeat(48), () => now),
      () => now,
    );
    await store.create({
      clinicId,
      queueEntryId,
      intent: 'initial',
      material: MATERIAL,
      exchangeExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    await pool.query(`UPDATE guest_link_intents SET envelope_ciphertext = $1`, [
      `https://clinic.example/exchange#${MATERIAL}`,
    ]);
    await pool.query(
      `UPDATE public_guest_booking_receipts SET access_ciphertext = $1`,
      ['aaa.bbb.ccc'],
    );
    const report = await inspectCiphertextAtRest(pool, now);
    expect(report.clean).toBe(false);
    expect(report.guestLinkIntents.malformedCiphertext).toBe(1);
    expect(report.bookingReceipts.malformedCiphertext).toBe(1);
  });

  it('flags version-prefixed envelopes with a wrong IV or tag length', async () => {
    const { clinicId, queueEntryId } = await bookOne();
    const store = new GuestLinkIntentStore(
      pool,
      new GuestLinkEnvelope('x'.repeat(48), () => now),
      () => now,
    );
    await store.create({
      clinicId,
      queueEntryId,
      intent: 'initial',
      material: MATERIAL,
      exchangeExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    await pool.query(`UPDATE guest_link_intents SET envelope_ciphertext = $1`, [
      'gle1.a.b.c',
    ]);
    await pool.query(
      `UPDATE public_guest_booking_receipts SET access_ciphertext = $1`,
      ['v1.a.b.c'],
    );
    const report = await inspectCiphertextAtRest(pool, now);
    expect(report.guestLinkIntents.malformedCiphertext).toBe(1);
    expect(report.bookingReceipts.malformedCiphertext).toBe(1);
  });

  it('flags envelopes whose separators are not literal dots', async () => {
    const { clinicId, queueEntryId } = await bookOne();
    const store = new GuestLinkIntentStore(
      pool,
      new GuestLinkEnvelope('x'.repeat(48), () => now),
      () => now,
    );
    await store.create({
      clinicId,
      queueEntryId,
      intent: 'initial',
      material: MATERIAL,
      exchangeExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    const body = `${'a'.repeat(16)}Y${'b'.repeat(32)}Z${'c'.repeat(22)}`;
    await pool.query(`UPDATE guest_link_intents SET envelope_ciphertext = $1`, [
      `gle1X${body}`,
    ]);
    await pool.query(
      `UPDATE public_guest_booking_receipts SET access_ciphertext = $1`,
      [`v1X${body}`],
    );
    const report = await inspectCiphertextAtRest(pool, now);
    expect(report.guestLinkIntents.malformedCiphertext).toBe(1);
    expect(report.bookingReceipts.malformedCiphertext).toBe(1);
  });
});
