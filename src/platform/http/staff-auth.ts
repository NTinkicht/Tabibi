import type { Queryable } from '@/modules/identity';
import { AuthorizationError, type ClinicScope } from '@/modules/identity';

/** Resolves an already-authenticated upstream subject; raw user IDs are never trusted. */
export async function authenticatedClinicScope(
  db: Queryable,
  request: Request,
  clinicId: string,
): Promise<ClinicScope> {
  const subject = request.headers.get('x-auth-subject');
  if (!subject) throw new AuthorizationError();
  const result = await db.query<{ id: string }>(
    'SELECT id FROM users WHERE auth_subject = $1',
    [subject],
  );
  const actorUserId = result.rows[0]?.id;
  if (!actorUserId) throw new AuthorizationError();
  return { clinicId, actorUserId };
}
