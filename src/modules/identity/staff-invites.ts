import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool } from 'pg';
import {
  AuthorizationError,
  requireClinicRole,
  type ClinicScope,
  type Queryable,
} from './index';
import { setStaffPassword, validatePasswordPolicy } from './staff-credentials';

/** Roles a clinic_admin may grant through an invite (least privilege, #727). */
export const INVITABLE_ROLES = ['doctor', 'receptionist'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const INVITE_DEFAULT_TTL_SECONDS = 7 * 24 * 3600;
export const INVITE_MAX_TTL_SECONDS = 14 * 24 * 3600;

const TOKEN_PATTERN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class InviteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteInputError';
  }
}

/** An open invite for the same clinic and email already exists (decision: refuse). */
export class InviteConflictError extends Error {
  constructor() {
    super('An open invite already exists for this email and clinic');
    this.name = 'InviteConflictError';
  }
}

/** One generic error for unknown, expired, revoked and already-used tokens. */
export class InviteRejectedError extends Error {
  constructor() {
    super('Invite is not valid');
    this.name = 'InviteRejectedError';
  }
}

/**
 * Revoking an invite that does not exist in this clinic (unknown, malformed,
 * another clinic's, already revoked or accepted). A subclass of
 * InviteRejectedError so service callers keep one generic error, while the
 * admin HTTP route can answer 404 instead of the accept route's 400.
 */
export class InviteNotFoundError extends InviteRejectedError {
  constructor() {
    super();
    this.name = 'InviteNotFoundError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An open (not revoked, not accepted) invite as the clinic admin sees it. */
export interface OpenInvite {
  inviteId: string;
  email: string;
  role: InvitableRole;
  createdAt: Date;
  expiresAt: Date;
  /** `expired` invites still block a new invite for the email until revoked. */
  status: 'pending' | 'expired';
}

/** What the invitee may see before accepting: no other clinic data. */
export interface InvitePreview {
  clinicName: string;
  email: string;
  role: InvitableRole;
  expiresAt: Date;
}

export interface CreatedInvite {
  inviteId: string;
  /** Returned exactly once; only its SHA-256 verifier is stored. */
  token: string;
  expiresAt: Date;
}

function verifierOf(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function normalizeInviteEmail(raw: string): string {
  const email = raw.normalize('NFKC').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new InviteInputError('Invalid email');
  }
  return email;
}

async function audit(
  db: Queryable,
  clinicId: string,
  actorUserId: string,
  inviteId: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  // Metadata carries ids and roles only: never the token, verifier or password.
  await db.query(
    `INSERT INTO audit_events (clinic_id, actor_user_id, entity_type, entity_id, action, metadata)
     VALUES ($1, $2, 'staff_invite', $3, $4, $5::jsonb)`,
    [clinicId, actorUserId, inviteId, action, JSON.stringify(metadata)],
  );
}

export class StaffInviteService {
  constructor(private readonly pool: Pool) {}

  async create(
    scope: ClinicScope,
    input: { email: string; role: string; ttlSeconds?: number },
    now = new Date(),
  ): Promise<CreatedInvite> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await requireClinicRole(client, scope, ['clinic_admin']);
      if (!(INVITABLE_ROLES as readonly string[]).includes(input.role)) {
        throw new InviteInputError('Role cannot be granted by invite');
      }
      const ttl = input.ttlSeconds ?? INVITE_DEFAULT_TTL_SECONDS;
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > INVITE_MAX_TTL_SECONDS) {
        throw new InviteInputError('Invalid invite lifetime');
      }
      const email = normalizeInviteEmail(input.email);
      const inviteId = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + ttl * 1000);
      const inserted = await client.query(
        `INSERT INTO staff_invites
           (id, clinic_id, email, role, token_verifier, invited_by, expires_at, created_at)
         VALUES ($1, $2, $3, $4::membership_role, $5, $6, $7, $8)
         ON CONFLICT (clinic_id, email) WHERE revoked_at IS NULL AND accepted_at IS NULL
         DO NOTHING`,
        [
          inviteId,
          scope.clinicId,
          email,
          input.role,
          verifierOf(secret),
          scope.actorUserId,
          expiresAt,
          now,
        ],
      );
      if (inserted.rowCount === 0) throw new InviteConflictError();
      await audit(
        client,
        scope.clinicId,
        scope.actorUserId,
        inviteId,
        'invite_created',
        {
          role: input.role,
          expiresAt: expiresAt.toISOString(),
        },
      );
      await client.query('COMMIT');
      return { inviteId, token: `${inviteId}.${secret}`, expiresAt };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * G-18 (#824): the clinic's open invites, newest first. Clinic admins only.
   * Never returns the token or its verifier.
   */
  async listOpen(scope: ClinicScope, now = new Date()): Promise<OpenInvite[]> {
    await requireClinicRole(this.pool, scope, ['clinic_admin']);
    const result = await this.pool.query<{
      id: string;
      email: string;
      role: InvitableRole;
      created_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, email, role, created_at, expires_at FROM staff_invites
        WHERE clinic_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL
        ORDER BY created_at DESC, id`,
      [scope.clinicId],
    );
    return result.rows.map((row) => ({
      inviteId: row.id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.expires_at.getTime() <= now.getTime() ? 'expired' : 'pending',
    }));
  }

  /**
   * G-18 (#824): what an invite grants, for the accept page, given the full
   * token. Unknown, expired, revoked, used, malformed and wrong-secret tokens
   * are the one generic InviteRejectedError, exactly as accept() answers.
   */
  async preview(token: string, now = new Date()): Promise<InvitePreview> {
    const match = TOKEN_PATTERN.exec(token);
    if (!match) throw new InviteRejectedError();
    const [, inviteId, secret] = match as unknown as [string, string, string];
    const found = await this.pool.query<{
      email: string;
      role: InvitableRole;
      token_verifier: Buffer;
      expires_at: Date;
      revoked_at: Date | null;
      accepted_at: Date | null;
      clinic_name: string;
    }>(
      `SELECT invite.email, invite.role, invite.token_verifier, invite.expires_at,
              invite.revoked_at, invite.accepted_at, clinic.name AS clinic_name
         FROM staff_invites invite
         JOIN clinics clinic ON clinic.id = invite.clinic_id
        WHERE invite.id = $1`,
      [inviteId],
    );
    const invite = found.rows[0];
    if (
      !invite ||
      !timingSafeEqual(verifierOf(secret), invite.token_verifier) ||
      invite.revoked_at !== null ||
      invite.accepted_at !== null ||
      invite.expires_at.getTime() <= now.getTime()
    ) {
      throw new InviteRejectedError();
    }
    return {
      clinicName: invite.clinic_name,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expires_at,
    };
  }

  async revoke(
    scope: ClinicScope,
    inviteId: string,
    now = new Date(),
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await requireClinicRole(client, scope, ['clinic_admin']);
      if (!UUID_PATTERN.test(inviteId)) throw new InviteNotFoundError();
      // The clinic_id predicate makes a cross-clinic invite id indistinguishable from a missing one.
      const revoked = await client.query(
        `UPDATE staff_invites SET revoked_at = $3
          WHERE id = $1 AND clinic_id = $2 AND revoked_at IS NULL AND accepted_at IS NULL`,
        [inviteId, scope.clinicId, now],
      );
      if (revoked.rowCount === 0) throw new InviteNotFoundError();
      await audit(
        client,
        scope.clinicId,
        scope.actorUserId,
        inviteId,
        'invite_revoked',
        {},
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Accepting creates or links the user, sets the password through the
   * credential service and creates the membership in one transaction. The row
   * lock on the invite gives a concurrent double-accept exactly one winner. An
   * existing account that already has a password keeps it: the token proves
   * control of the invited email, not of the account.
   */
  async accept(
    token: string,
    input: { displayName: string; password: string },
    now = new Date(),
  ): Promise<{ userId: string; clinicId: string; role: InvitableRole }> {
    const match = TOKEN_PATTERN.exec(token);
    if (!match) throw new InviteRejectedError();
    const [, inviteId, secret] = match as unknown as [string, string, string];
    const displayName = input.displayName.trim();
    if (displayName === '' || displayName.length > 120) {
      throw new InviteInputError('Invalid display name');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        clinic_id: string;
        email: string;
        role: InvitableRole;
        token_verifier: Buffer;
        expires_at: Date;
        revoked_at: Date | null;
        accepted_at: Date | null;
      }>('SELECT * FROM staff_invites WHERE id = $1 FOR UPDATE', [inviteId]);
      const invite = found.rows[0];
      const presented = verifierOf(secret);
      if (
        !invite ||
        !timingSafeEqual(presented, invite.token_verifier) ||
        invite.revoked_at !== null ||
        invite.accepted_at !== null ||
        invite.expires_at.getTime() <= now.getTime()
      ) {
        throw new InviteRejectedError();
      }
      validatePasswordPolicy(input.password, invite.email);

      const existing = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE auth_subject = $1 FOR UPDATE',
        [invite.email],
      );
      let userId = existing.rows[0]?.id;
      if (userId === undefined) {
        userId = randomUUID();
        await client.query(
          'INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $3)',
          [userId, invite.email, displayName],
        );
      }
      // Separate statement after the user lock: under READ COMMITTED it sees a
      // credential committed by a concurrent acceptance that held the lock.
      const credential = await client.query(
        'SELECT 1 FROM staff_credentials WHERE user_id = $1',
        [userId],
      );
      if (credential.rowCount === 0) {
        await setStaffPassword(client, userId, input.password);
      }
      if (invite.role === 'doctor') {
        // Same invariant as ClinicService.addDoctor: a doctor membership needs
        // the shared profile and this clinic's association.
        await client.query(
          `INSERT INTO doctor_profiles (id, user_id, display_name) VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO NOTHING`,
          [randomUUID(), userId, displayName],
        );
        await client.query(
          `INSERT INTO doctor_clinics (clinic_id, doctor_id)
           SELECT $1, id FROM doctor_profiles WHERE user_id = $2
           ON CONFLICT DO NOTHING`,
          [invite.clinic_id, userId],
        );
        // G-19: a doctor who left this clinic and is invited back is listed
        // and bookable again (see clinic/active-doctor.ts).
        await client.query(
          `UPDATE doctor_clinics SET departed_at = NULL
            WHERE clinic_id = $1 AND departed_at IS NOT NULL
              AND doctor_id = (SELECT id FROM doctor_profiles WHERE user_id = $2)`,
          [invite.clinic_id, userId],
        );
      }
      const membership = await client.query(
        `INSERT INTO clinic_memberships (clinic_id, user_id, role)
         VALUES ($1, $2, $3::membership_role) ON CONFLICT (clinic_id, user_id) DO NOTHING`,
        [invite.clinic_id, userId, invite.role],
      );
      // A pre-existing membership (any role) is never silently changed by an invite.
      if (membership.rowCount === 0) throw new InviteRejectedError();
      await client.query(
        'UPDATE staff_invites SET accepted_at = $2, accepted_user_id = $3 WHERE id = $1',
        [inviteId, now, userId],
      );
      await audit(
        client,
        invite.clinic_id,
        userId,
        inviteId,
        'invite_accepted',
        {
          role: invite.role,
        },
      );
      await client.query('COMMIT');
      return { userId, clinicId: invite.clinic_id, role: invite.role };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export { AuthorizationError };
