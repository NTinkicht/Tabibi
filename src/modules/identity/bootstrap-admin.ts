import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { setStaffPassword } from './staff-credentials';
import { normalizeInviteEmail } from './staff-invites';

export type BootstrapResult =
  | { status: 'created'; userId: string }
  | { status: 'already_exists' };

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/**
 * Operator-only. Creates the first clinic_admin of a clinic. Idempotent: when
 * the clinic already has any clinic_admin it changes nothing. The clinic row is
 * locked so two concurrent runs cannot both create an administrator. An
 * existing account with the same email is refused rather than reused, so this
 * command can never reset someone else's password.
 */
export async function bootstrapFirstClinicAdmin(
  pool: Pool,
  input: {
    clinicId: string;
    email: string;
    displayName: string;
    password: string;
  },
): Promise<BootstrapResult> {
  const email = normalizeInviteEmail(input.email);
  const displayName = input.displayName.trim();
  if (displayName === '' || displayName.length > 120) {
    throw new BootstrapError('Invalid display name');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clinic = await client.query(
      'SELECT id FROM clinics WHERE id = $1 FOR UPDATE',
      [input.clinicId],
    );
    if (clinic.rowCount === 0) throw new BootstrapError('Clinic not found');
    const admins = await client.query(
      `SELECT 1 FROM clinic_memberships WHERE clinic_id = $1 AND role = 'clinic_admin' LIMIT 1`,
      [input.clinicId],
    );
    if ((admins.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return { status: 'already_exists' };
    }
    const taken = await client.query(
      'SELECT 1 FROM users WHERE auth_subject = $1',
      [email],
    );
    if ((taken.rowCount ?? 0) > 0)
      throw new BootstrapError('An account with this email already exists');
    const userId = randomUUID();
    await client.query(
      'INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $3)',
      [userId, email, displayName],
    );
    await setStaffPassword(client, userId, input.password);
    await client.query(
      `INSERT INTO clinic_memberships (clinic_id, user_id, role) VALUES ($1, $2, 'clinic_admin')`,
      [input.clinicId, userId],
    );
    await client.query(
      `INSERT INTO audit_events (clinic_id, actor_user_id, entity_type, entity_id, action, metadata)
       VALUES ($1, $2, 'membership', $2, 'bootstrap_clinic_admin', '{}'::jsonb)`,
      [input.clinicId, userId],
    );
    await client.query('COMMIT');
    return { status: 'created', userId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
