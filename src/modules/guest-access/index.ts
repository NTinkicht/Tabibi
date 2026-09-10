import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import { requireClinicRole } from '@/modules/identity';
import { abortableQuery } from '@/platform/database/abortable-query';
import { inTransaction } from '@/platform/database/transaction';

const EXCHANGE_TTL_MS = 10 * 60 * 1_000;
const BEARER_TTL_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_ENTRY_STATES = [
  'waiting',
  'checked_in',
  'called',
  'in_consultation',
];
const ACTIVE_SESSION_STATES = ['planned', 'open', 'paused'];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEARER_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class GuestAccessRejectedError extends Error {
  constructor() {
    super('Guest access exchange rejected');
  }
}

export type GuestTarget = {
  clinicId: string;
  sessionId: string;
  queueEntryId: string;
};

type ParsedBearer = {
  credentialId: string;
  secret: string;
  signature: string;
};

function secret(): string {
  return randomBytes(32).toString('base64url');
}

function verifier(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function guestBearerSigningSecret(): string {
  const signingSecret = process.env.GUEST_BEARER_SIGNING_SECRET;
  if (!signingSecret || signingSecret.length < 32) {
    throw new Error(
      'GUEST_BEARER_SIGNING_SECRET must contain at least 32 characters',
    );
  }
  return signingSecret;
}

function bearerSignature(credentialId: string, bearerSecret: string): string {
  return createHmac('sha256', guestBearerSigningSecret())
    .update(`${credentialId}.${bearerSecret}`, 'utf8')
    .digest('base64url');
}

function parseBearer(bearer: string): ParsedBearer | null {
  const parts = bearer.split('.');
  if (parts.length !== 3) return null;
  const [credentialId, bearerSecret, signature] = parts;
  if (
    !credentialId ||
    !bearerSecret ||
    !signature ||
    !UUID_PATTERN.test(credentialId) ||
    !BEARER_SIGNATURE_PATTERN.test(signature)
  )
    return null;
  return { credentialId, secret: bearerSecret, signature };
}

function authenticatedBearer(bearer: string): ParsedBearer | null {
  const parsed = parseBearer(bearer);
  if (!parsed) return null;
  const expected = Buffer.from(
    bearerSignature(parsed.credentialId, parsed.secret),
    'utf8',
  );
  const provided = Buffer.from(parsed.signature, 'utf8');
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  )
    return null;
  return parsed;
}

/** Verify the server-authenticated bearer envelope without querying credential storage. */
export function authenticatedGuestCredentialId(bearer: string): string | null {
  return authenticatedBearer(bearer)?.credentialId.toLowerCase() ?? null;
}

function verifierMatches(
  storedVerifier: string,
  bearerSecret: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(storedVerifier)) return false;
  const stored = Buffer.from(storedVerifier, 'hex');
  const candidate = Buffer.from(verifier(bearerSecret), 'hex');
  return (
    stored.length === candidate.length && timingSafeEqual(stored, candidate)
  );
}

/** PostgreSQL-backed guest credential primitive. Raw secrets never cross a query boundary. */
export class GuestAccessService {
  constructor(
    private readonly pool: Pool,
    private readonly afterConsumeForTest?: (
      client: PoolClient,
    ) => Promise<void>,
  ) {}

  async issue(
    target: GuestTarget,
    actorUserId: string,
    now = new Date(),
  ): Promise<{ exchangeId: string; expiresAt: Date }> {
    const exchangeId = secret();
    const expiresAt = new Date(now.getTime() + EXCHANGE_TTL_MS);
    await inTransaction(this.pool, async (client) => {
      await requireClinicRole(
        client,
        { clinicId: target.clinicId, actorUserId },
        ['receptionist', 'clinic_admin'],
      );
      const result = await client.query<{
        state: string;
        session_status: string;
        contact_phone: string | null;
        contact_email: string | null;
      }>(
        `SELECT entry.state, session.status AS session_status,
                patient.contact_phone, patient.contact_email
           FROM queue_entries entry
           JOIN consultation_sessions session
             ON session.id=entry.session_id AND session.clinic_id=entry.clinic_id
           JOIN patient_operational_records patient
             ON patient.id=entry.patient_id AND patient.clinic_id=entry.clinic_id
          WHERE entry.id=$1 AND entry.session_id=$2 AND entry.clinic_id=$3
          FOR UPDATE OF entry, session, patient`,
        [target.queueEntryId, target.sessionId, target.clinicId],
      );
      const row = result.rows[0];
      if (
        !row ||
        !ACTIVE_ENTRY_STATES.includes(row.state) ||
        !ACTIVE_SESSION_STATES.includes(row.session_status) ||
        (!row.contact_phone && !row.contact_email)
      ) {
        throw new GuestAccessRejectedError();
      }
      const contactKind = row.contact_phone ? 'phone' : 'email';
      await client.query(
        `INSERT INTO guest_exchange_ids
           (id,clinic_id,session_id,queue_entry_id,issued_by_user_id,
            exchange_verifier,contact_kind,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          target.clinicId,
          target.sessionId,
          target.queueEntryId,
          actorUserId,
          verifier(exchangeId),
          contactKind,
          now,
          expiresAt,
        ],
      );
      await appendAuditEvent(client, {
        clinicId: target.clinicId,
        actorUserId,
        entityType: 'queue_entry',
        entityId: target.queueEntryId,
        action: 'guest_exchange_issued',
        metadata: {
          sessionId: target.sessionId,
          contactKind,
          expiresAt: expiresAt.toISOString(),
        },
      });
    });
    return { exchangeId, expiresAt };
  }

  async consume(
    exchangeId: string,
    expectedTarget?: GuestTarget,
    now = new Date(),
  ): Promise<{ bearer: string; expiresAt: Date; target: GuestTarget }> {
    const exchangeVerifier = verifier(exchangeId);
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<{
        id: string;
        clinic_id: string;
        session_id: string;
        queue_entry_id: string;
        issued_by_user_id: string;
        expires_at: Date;
        consumed_at: Date | null;
        entry_state: string;
        session_status: string;
      }>(
        `SELECT exchange.id,exchange.clinic_id,exchange.session_id,exchange.queue_entry_id,
                exchange.issued_by_user_id,exchange.expires_at,exchange.consumed_at,
                entry.state AS entry_state,session.status AS session_status
           FROM guest_exchange_ids exchange
           JOIN queue_entries entry ON entry.id=exchange.queue_entry_id
             AND entry.clinic_id=exchange.clinic_id AND entry.session_id=exchange.session_id
           JOIN consultation_sessions session ON session.id=exchange.session_id
             AND session.clinic_id=exchange.clinic_id
          WHERE exchange.exchange_verifier=$1
          FOR UPDATE OF exchange, entry, session`,
        [exchangeVerifier],
      );
      const row = result.rows[0];
      const target: GuestTarget | undefined = row
        ? {
            clinicId: row.clinic_id,
            sessionId: row.session_id,
            queueEntryId: row.queue_entry_id,
          }
        : undefined;
      if (
        !row ||
        row.consumed_at ||
        row.expires_at <= now ||
        !ACTIVE_ENTRY_STATES.includes(row.entry_state) ||
        !ACTIVE_SESSION_STATES.includes(row.session_status) ||
        (expectedTarget &&
          (expectedTarget.clinicId !== target?.clinicId ||
            expectedTarget.sessionId !== target?.sessionId ||
            expectedTarget.queueEntryId !== target?.queueEntryId))
      )
        throw new GuestAccessRejectedError();

      const liveCredential = await client.query<{ id: string }>(
        `SELECT id
           FROM guest_credentials
          WHERE queue_entry_id=$1 AND revoked_at IS NULL
          FOR UPDATE`,
        [row.queue_entry_id],
      );
      if (liveCredential.rows[0]) throw new GuestAccessRejectedError();

      const credentialId = randomUUID();
      const bearerSecret = secret();
      const bearer = `${credentialId}.${bearerSecret}.${bearerSignature(credentialId, bearerSecret)}`;
      const expiresAt = new Date(now.getTime() + BEARER_TTL_MS);
      await client.query(
        'UPDATE guest_exchange_ids SET consumed_at=$2 WHERE id=$1',
        [row.id, now],
      );
      if (this.afterConsumeForTest) await this.afterConsumeForTest(client);
      await client.query(
        `INSERT INTO guest_credentials
           (id,clinic_id,session_id,queue_entry_id,bearer_verifier,issued_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          credentialId,
          row.clinic_id,
          row.session_id,
          row.queue_entry_id,
          verifier(bearerSecret),
          now,
          expiresAt,
        ],
      );
      await appendAuditEvent(client, {
        clinicId: row.clinic_id,
        actorUserId: row.issued_by_user_id,
        entityType: 'queue_entry',
        entityId: row.queue_entry_id,
        action: 'guest_exchange_consumed',
        metadata: {
          sessionId: row.session_id,
          credentialExpiresAt: expiresAt.toISOString(),
        },
      });
      if (!target) throw new GuestAccessRejectedError();
      return { bearer, expiresAt, target };
    });
  }

  async authorize(
    bearer: string,
    expectedTarget?: GuestTarget,
    now = new Date(),
    signal?: AbortSignal,
  ): Promise<GuestTarget> {
    const parsed = authenticatedBearer(bearer);
    if (!parsed) throw new GuestAccessRejectedError();

    const result = await abortableQuery<{
      bearer_verifier: string;
      clinic_id: string;
      session_id: string;
      queue_entry_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      entry_state: string;
      session_status: string;
    }>(
      this.pool,
      `SELECT credential.bearer_verifier,credential.clinic_id,credential.session_id,
              credential.queue_entry_id,credential.expires_at,credential.revoked_at,
              entry.state AS entry_state,session.status AS session_status
         FROM guest_credentials credential
         JOIN queue_entries entry ON entry.id=credential.queue_entry_id
           AND entry.clinic_id=credential.clinic_id
           AND entry.session_id=credential.session_id
         JOIN consultation_sessions session ON session.id=credential.session_id
           AND session.clinic_id=credential.clinic_id
        WHERE credential.id=$1`,
      [parsed.credentialId],
      signal,
    );
    const row = result.rows[0];
    if (!row || !verifierMatches(row.bearer_verifier, parsed.secret))
      throw new GuestAccessRejectedError();

    const target: GuestTarget = {
      clinicId: row.clinic_id,
      sessionId: row.session_id,
      queueEntryId: row.queue_entry_id,
    };
    if (
      row.revoked_at ||
      row.expires_at <= now ||
      !ACTIVE_ENTRY_STATES.includes(row.entry_state) ||
      !ACTIVE_SESSION_STATES.includes(row.session_status) ||
      (expectedTarget &&
        (expectedTarget.clinicId !== target.clinicId ||
          expectedTarget.sessionId !== target.sessionId ||
          expectedTarget.queueEntryId !== target.queueEntryId))
    )
      throw new GuestAccessRejectedError();
    return target;
  }
}
