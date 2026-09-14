import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { inTransaction } from '@/platform/database/transaction';

const ACTIVE_SESSION_STATES = ['planned', 'open', 'paused'];
const ACCESS_TTL_MS = 24 * 60 * 60 * 1_000;
const RECEIPT_CIPHER_VERSION = 'v1';
const RECEIPT_IV_BYTES = 12;

export type PublicBookingLocale = 'ar' | 'fr';
export type PublicBookingContactPreference = 'none' | 'phone' | 'email';

export interface PublicGuestBookingInput {
  selectionReference: string;
  privateDisplayName: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
  preferredLocale: PublicBookingLocale;
  contactPreference: PublicBookingContactPreference;
  idempotencyKey: string;
  correlationId: string;
}

export interface PublicGuestBookingResult {
  serviceDate: string;
  startsAt: string;
  endsAt: string;
  queueLabel: string;
  guestBearer: string;
  guestAccessExpiresAt: string;
}

export class PublicGuestBookingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicGuestBookingValidationError';
  }
}

export class PublicGuestBookingRejectedError extends Error {
  constructor() {
    super('Guest booking request could not be completed');
    this.name = 'PublicGuestBookingRejectedError';
  }
}

type NormalizedInput = {
  selectionReference: string;
  privateDisplayName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  preferredLocale: PublicBookingLocale;
  contactPreference: PublicBookingContactPreference;
  idempotencyKey: string;
  correlationId: string;
};

function normalizeOptional(value?: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeEmail(value?: string | null): string | null {
  const email = normalizeOptional(value);
  if (!email) return null;
  const separator = email.lastIndexOf('@');
  if (separator < 0) return email;
  return `${email.slice(0, separator)}@${email.slice(separator + 1).toLowerCase()}`;
}

function normalizeInput(input: PublicGuestBookingInput): NormalizedInput {
  const privateDisplayName = input.privateDisplayName.trim();
  if (privateDisplayName.length < 1 || privateDisplayName.length > 120) {
    throw new PublicGuestBookingValidationError(
      'Guest name must be between 1 and 120 characters',
    );
  }
  if (!['ar', 'fr'].includes(input.preferredLocale)) {
    throw new PublicGuestBookingValidationError('Unsupported locale');
  }
  if (!['none', 'phone', 'email'].includes(input.contactPreference)) {
    throw new PublicGuestBookingValidationError('Unsupported contact preference');
  }
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128) {
    throw new PublicGuestBookingValidationError(
      'Idempotency key is required and must be at most 128 characters',
    );
  }
  if (input.correlationId.length < 1 || input.correlationId.length > 128) {
    throw new PublicGuestBookingValidationError(
      'Correlation id is required and must be at most 128 characters',
    );
  }
  if (!input.selectionReference || input.selectionReference.length > 4096) {
    throw new PublicGuestBookingValidationError(
      'Availability selection reference is required',
    );
  }

  const contactPhone = normalizeOptional(input.contactPhone);
  const contactEmail = normalizeEmail(input.contactEmail);
  if (contactPhone && (contactPhone.length < 3 || contactPhone.length > 32)) {
    throw new PublicGuestBookingValidationError(
      'Contact phone must be between 3 and 32 characters',
    );
  }
  if (contactEmail && (contactEmail.length < 3 || contactEmail.length > 254)) {
    throw new PublicGuestBookingValidationError(
      'Contact email must be between 3 and 254 characters',
    );
  }
  if (!contactPhone && !contactEmail) {
    throw new PublicGuestBookingValidationError(
      'At least one contact method is required',
    );
  }
  if (input.contactPreference === 'phone' && !contactPhone) {
    throw new PublicGuestBookingValidationError(
      'Phone contact preference requires a phone number',
    );
  }
  if (input.contactPreference === 'email' && !contactEmail) {
    throw new PublicGuestBookingValidationError(
      'Email contact preference requires an email address',
    );
  }

  return {
    selectionReference: input.selectionReference,
    privateDisplayName,
    contactPhone,
    contactEmail,
    preferredLocale: input.preferredLocale,
    contactPreference: input.contactPreference,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
  };
}

function bookingFingerprint(
  selection: {
    clinicId: string;
    doctorId: string;
    sessionId: string;
    startsAt: string;
    endsAt: string;
  },
  input: NormalizedInput,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        selection.clinicId,
        selection.doctorId,
        selection.sessionId,
        selection.startsAt,
        selection.endsAt,
        input.privateDisplayName,
        input.contactPhone,
        input.contactEmail,
        input.preferredLocale,
        input.contactPreference,
      ]),
    )
    .digest('hex');
}

function idempotencyHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function guestSigningSecret(): string {
  const value = process.env.GUEST_BEARER_SIGNING_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      'GUEST_BEARER_SIGNING_SECRET must contain at least 32 characters',
    );
  }
  return value;
}

function credentialVerifier(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function bearerSignature(credentialId: string, bearerSecret: string): string {
  return createHmac('sha256', guestSigningSecret())
    .update(`${credentialId}.${bearerSecret}`, 'utf8')
    .digest('base64url');
}

function receiptEncryptionKey(): Buffer {
  return createHash('sha256')
    .update('tabibi-public-guest-booking-replay\0', 'utf8')
    .update(guestSigningSecret(), 'utf8')
    .digest();
}

function encryptBearer(bearer: string): string {
  const iv = randomBytes(RECEIPT_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', receiptEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(RECEIPT_CIPHER_VERSION, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(bearer, 'utf8'),
    cipher.final(),
  ]);
  return [
    RECEIPT_CIPHER_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

function decryptBearer(value: string): string {
  try {
    const [version, ivEncoded, ciphertextEncoded, tagEncoded, extra] =
      value.split('.');
    if (
      version !== RECEIPT_CIPHER_VERSION ||
      extra !== undefined ||
      !ivEncoded ||
      !ciphertextEncoded ||
      !tagEncoded
    ) {
      throw new Error('invalid receipt ciphertext');
    }
    const iv = Buffer.from(ivEncoded, 'base64url');
    const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');
    const tag = Buffer.from(tagEncoded, 'base64url');
    if (iv.length !== RECEIPT_IV_BYTES || tag.length !== 16) {
      throw new Error('invalid receipt ciphertext');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      receiptEncryptionKey(),
      iv,
    );
    decipher.setAAD(Buffer.from(RECEIPT_CIPHER_VERSION, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new PublicGuestBookingRejectedError();
  }
}

async function loadCompletedBooking(
  client: PoolClient,
  clinicId: string,
  idempotencyKey: string,
): Promise<PublicGuestBookingResult> {
  const result = await client.query<{
    access_ciphertext: string;
    credential_expires_at: Date;
    service_date: string;
    starts_at: Date;
    ends_at: Date;
    public_display_label: string;
  }>(
    `SELECT receipt.access_ciphertext,
            credential.expires_at AS credential_expires_at,
            session.service_date::text AS service_date,
            appointment.scheduled_start_at AS starts_at,
            appointment.scheduled_end_at AS ends_at,
            entry.public_display_label
       FROM public_guest_booking_receipts receipt
       JOIN appointments appointment
         ON appointment.id = receipt.appointment_id
        AND appointment.clinic_id = receipt.clinic_id
       JOIN queue_entries entry
         ON entry.id = receipt.queue_entry_id
        AND entry.clinic_id = receipt.clinic_id
       JOIN consultation_sessions session
         ON session.id = appointment.session_id
        AND session.clinic_id = appointment.clinic_id
       JOIN guest_credentials credential
         ON credential.id = receipt.credential_id
        AND credential.clinic_id = receipt.clinic_id
      WHERE receipt.clinic_id = $1
        AND receipt.idempotency_key = $2
        AND receipt.completed_at IS NOT NULL`,
    [clinicId, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row?.access_ciphertext) throw new PublicGuestBookingRejectedError();
  return {
    serviceDate: row.service_date,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    queueLabel: row.public_display_label,
    guestBearer: decryptBearer(row.access_ciphertext),
    guestAccessExpiresAt: row.credential_expires_at.toISOString(),
  };
}

export class PublicGuestBookingService {
  constructor(
    private readonly pool: Pool,
    private readonly selections: PublicAvailabilitySelectionService,
    private readonly clock: () => Date = () => new Date(),
    private readonly afterOperationalMutationForTest?: (
      client: PoolClient,
    ) => Promise<void>,
  ) {}

  async book(rawInput: PublicGuestBookingInput): Promise<PublicGuestBookingResult> {
    const input = normalizeInput(rawInput);

    return inTransaction(this.pool, async (client) => {
      const selection = await this.selections.resolveForMutation(
        input.selectionReference,
        client,
      );
      if (!selection) throw new PublicGuestBookingRejectedError();

      const requestFingerprint = bookingFingerprint(selection, input);
      const claimed = await client.query(
        `INSERT INTO public_guest_booking_receipts
           (clinic_id, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3)
         ON CONFLICT (clinic_id, idempotency_key) DO NOTHING
         RETURNING clinic_id`,
        [selection.clinicId, input.idempotencyKey, requestFingerprint],
      );

      if (claimed.rowCount !== 1) {
        const existing = await client.query<{ request_fingerprint: string }>(
          `SELECT request_fingerprint
             FROM public_guest_booking_receipts
            WHERE clinic_id = $1 AND idempotency_key = $2`,
          [selection.clinicId, input.idempotencyKey],
        );
        if (existing.rows[0]?.request_fingerprint !== requestFingerprint) {
          throw new PublicGuestBookingRejectedError();
        }
        return loadCompletedBooking(
          client,
          selection.clinicId,
          input.idempotencyKey,
        );
      }

      const sessionResult = await client.query<{
        doctor_id: string;
        starts_at: Date;
        ends_at: Date;
        status: string;
      }>(
        `SELECT session.doctor_id, session.starts_at, session.ends_at, session.status
           FROM consultation_sessions session
           JOIN clinics clinic
             ON clinic.id = session.clinic_id AND clinic.status = 'active'
           JOIN doctor_clinics association
             ON association.clinic_id = session.clinic_id
            AND association.doctor_id = session.doctor_id
          WHERE session.id = $1
            AND session.clinic_id = $2
            AND session.doctor_id = $3
          FOR UPDATE OF session`,
        [selection.sessionId, selection.clinicId, selection.doctorId],
      );
      const session = sessionResult.rows[0];
      if (
        !session ||
        !ACTIVE_SESSION_STATES.includes(session.status) ||
        session.starts_at.toISOString() !== selection.startsAt ||
        session.ends_at.toISOString() !== selection.endsAt ||
        session.starts_at <= this.clock()
      ) {
        throw new PublicGuestBookingRejectedError();
      }

      const orderResult = await client.query<{ next_order: string }>(
        `SELECT COALESCE(MAX(registration_order), 0) + 1 AS next_order
           FROM queue_entries
          WHERE session_id = $1`,
        [selection.sessionId],
      );
      const registrationOrder = Number(orderResult.rows[0]?.next_order ?? '1');
      const patientId = randomUUID();
      const queueEntryId = randomUUID();
      const appointmentId = randomUUID();
      const credentialId = randomUUID();
      const bearerSecret = randomBytes(32).toString('base64url');
      const guestBearer = `${credentialId}.${bearerSecret}.${bearerSignature(credentialId, bearerSecret)}`;
      const now = this.clock();
      const guestAccessExpiresAt = new Date(now.getTime() + ACCESS_TTL_MS);

      await client.query(
        `INSERT INTO patient_operational_records
           (id, clinic_id, private_display_name, contact_phone, contact_email, preferred_locale)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          patientId,
          selection.clinicId,
          input.privateDisplayName,
          input.contactPhone,
          input.contactEmail,
          input.preferredLocale,
        ],
      );
      await client.query(
        `INSERT INTO queue_entries
           (id, clinic_id, session_id, patient_id, state, source, registration_order,
            eligibility_order, priority_order)
         VALUES ($1, $2, $3, $4, 'waiting', 'appointment', $5, NULL, NULL)`,
        [
          queueEntryId,
          selection.clinicId,
          selection.sessionId,
          patientId,
          registrationOrder,
        ],
      );
      await client.query(
        `INSERT INTO appointments
           (id, clinic_id, doctor_id, session_id, patient_id, queue_entry_id,
            status, scheduled_start_at, scheduled_end_at, preferred_locale,
            contact_preference, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8, $9, $10, 'public')`,
        [
          appointmentId,
          selection.clinicId,
          selection.doctorId,
          selection.sessionId,
          patientId,
          queueEntryId,
          new Date(selection.startsAt),
          new Date(selection.endsAt),
          input.preferredLocale,
          input.contactPreference,
        ],
      );
      await client.query(
        `INSERT INTO guest_credentials
           (id, clinic_id, session_id, queue_entry_id, bearer_verifier, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          credentialId,
          selection.clinicId,
          selection.sessionId,
          queueEntryId,
          credentialVerifier(bearerSecret),
          now,
          guestAccessExpiresAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
           (clinic_id, actor_user_id, entity_type, entity_id, action, metadata)
         VALUES ($1, NULL, 'appointment', $2, 'public_guest_appointment_booked', $3::jsonb)`,
        [
          selection.clinicId,
          appointmentId,
          JSON.stringify({
            source: 'guest_public',
            status: 'confirmed',
            registrationOrder,
            preferredLocale: input.preferredLocale,
            contactPreference: input.contactPreference,
            hasPhone: input.contactPhone !== null,
            hasEmail: input.contactEmail !== null,
            correlationId: input.correlationId,
            idempotencyHash: idempotencyHash(input.idempotencyKey),
          }),
        ],
      );

      if (this.afterOperationalMutationForTest) {
        await this.afterOperationalMutationForTest(client);
      }

      await client.query(
        `UPDATE public_guest_booking_receipts
            SET patient_id = $3,
                queue_entry_id = $4,
                appointment_id = $5,
                credential_id = $6,
                access_ciphertext = $7,
                completed_at = $8
          WHERE clinic_id = $1
            AND idempotency_key = $2
            AND completed_at IS NULL`,
        [
          selection.clinicId,
          input.idempotencyKey,
          patientId,
          queueEntryId,
          appointmentId,
          credentialId,
          encryptBearer(guestBearer),
          now,
        ],
      );

      const result = await loadCompletedBooking(
        client,
        selection.clinicId,
        input.idempotencyKey,
      );
      return result;
    });
  }
}
