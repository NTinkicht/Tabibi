import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { Pool } from 'pg';

const VERSION = 'v1';
const IV_BYTES = 12;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface AvailabilitySelection {
  serviceDate: string;
  startsAt: string;
  endsAt: string;
}

export interface AvailabilitySelectionInput {
  clinicId: string;
  doctorId: string;
  sessionId: string;
  startsAt: string;
  endsAt: string;
}

/**
 * Server-only durable target for a validated selection reference.
 *
 * This type contains private domain identifiers and must never be serialized by
 * public routes. It exists so mutation services can bind authoritative writes to
 * the exact clinic/doctor/session tuple after the opaque reference has been
 * cryptographically validated and re-checked against current database truth.
 */
export interface RevalidatedAvailabilitySelection
  extends AvailabilitySelection,
    AvailabilitySelectionInput {}

interface SelectionClaims extends AvailabilitySelectionInput {
  version: 1;
  expiresAt: number;
}

interface AvailabilityRow {
  service_date: string;
  starts_at: Date;
  ends_at: Date;
}

export class PublicAvailabilitySelectionService {
  private readonly key: Buffer;

  constructor(
    private readonly pool: Pool,
    secret: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error(
        'Availability selection secret must be at least 32 bytes',
      );
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('Availability selection TTL must be positive');
    }
    this.key = createHash('sha256').update(secret, 'utf8').digest();
  }

  async issue(input: AvailabilitySelectionInput): Promise<string | null> {
    const current = await this.loadCurrent(input);
    if (current === null) return null;

    const now = this.clock().getTime();
    const claims: SelectionClaims = {
      version: 1,
      ...input,
      expiresAt: now + this.ttlMs,
    };
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(VERSION, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(claims), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      VERSION,
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  }

  async resolve(reference: string): Promise<AvailabilitySelection | null> {
    const current = await this.resolveForMutation(reference);
    if (current === null) return null;
    return {
      serviceDate: current.serviceDate,
      startsAt: current.startsAt,
      endsAt: current.endsAt,
    };
  }

  /**
   * Resolve an opaque reference for a server-side mutation boundary.
   *
   * The decrypted claims are never trusted by themselves: every identifier and
   * window is revalidated against current durable truth before this method
   * returns. Callers must keep the returned identifiers server-side.
   */
  async resolveForMutation(
    reference: string,
  ): Promise<RevalidatedAvailabilitySelection | null> {
    const claims = this.decode(reference);
    if (claims === null || this.clock().getTime() >= claims.expiresAt) {
      return null;
    }

    const current = await this.loadCurrent(claims);
    if (current === null) return null;
    return {
      clinicId: claims.clinicId,
      doctorId: claims.doctorId,
      sessionId: claims.sessionId,
      serviceDate: current.serviceDate,
      startsAt: current.startsAt,
      endsAt: current.endsAt,
    };
  }

  private decode(reference: string): SelectionClaims | null {
    try {
      const [version, ivEncoded, ciphertextEncoded, tagEncoded, extra] =
        reference.split('.');
      if (
        version !== VERSION ||
        extra !== undefined ||
        !ivEncoded ||
        !ciphertextEncoded ||
        !tagEncoded
      ) {
        return null;
      }

      const iv = Buffer.from(ivEncoded, 'base64url');
      const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');
      const tag = Buffer.from(tagEncoded, 'base64url');
      if (
        iv.length !== IV_BYTES ||
        tag.length !== 16 ||
        ciphertext.length === 0
      ) {
        return null;
      }

      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(VERSION, 'utf8'));
      decipher.setAuthTag(tag);
      const parsed: unknown = JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
          'utf8',
        ),
      );
      if (!isSelectionClaims(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async loadCurrent(
    input: AvailabilitySelectionInput,
  ): Promise<AvailabilitySelection | null> {
    const result = await this.pool.query<AvailabilityRow>(
      `SELECT session.service_date::text AS service_date,
              session.starts_at,
              session.ends_at
         FROM consultation_sessions session
         JOIN clinics clinic
           ON clinic.id = session.clinic_id
          AND clinic.status = 'active'
         JOIN doctor_clinics association
           ON association.clinic_id = session.clinic_id
          AND association.doctor_id = session.doctor_id
        WHERE session.id = $1
          AND session.clinic_id = $2
          AND session.doctor_id = $3
          AND session.status IN ('planned', 'open', 'paused')
        LIMIT 1`,
      [input.sessionId, input.clinicId, input.doctorId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    const startsAt = row.starts_at.toISOString();
    const endsAt = row.ends_at.toISOString();
    if (
      startsAt !== input.startsAt ||
      endsAt !== input.endsAt ||
      row.starts_at.getTime() <= this.clock().getTime()
    ) {
      return null;
    }

    return { serviceDate: row.service_date, startsAt, endsAt };
  }
}

function isSelectionClaims(value: unknown): value is SelectionClaims {
  if (typeof value !== 'object' || value === null) return false;
  const claims = value as Record<string, unknown>;
  const keys = Object.keys(claims).sort();
  const expected = [
    'clinicId',
    'doctorId',
    'endsAt',
    'expiresAt',
    'sessionId',
    'startsAt',
    'version',
  ].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, i) => key !== expected[i])
  ) {
    return false;
  }

  return (
    claims.version === 1 &&
    typeof claims.clinicId === 'string' &&
    typeof claims.doctorId === 'string' &&
    typeof claims.sessionId === 'string' &&
    typeof claims.startsAt === 'string' &&
    typeof claims.endsAt === 'string' &&
    typeof claims.expiresAt === 'number' &&
    Number.isFinite(claims.expiresAt)
  );
}
