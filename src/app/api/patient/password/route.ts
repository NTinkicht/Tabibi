import { z } from 'zod';
import { changePatientPassword } from '@/modules/identity/patient-credentials';
import { PasswordPolicyError } from '@/modules/identity/staff-credentials';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  authenticatedPatient,
  revokeOtherPatientSessions,
} from '@/platform/http/patient-auth';
import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';
import { requireSameOrigin } from '@/platform/http/staff-auth';

// TAB-P1-01 slice 4: signed-in patient password change. Session first, then
// same-origin, bounded strict body, ingress and per-account budgets. A wrong
// current password is one 403 and counts toward the account lockout; a policy
// failure on the new password changes nothing. After a change every other
// session of the account is revoked and the calling session stays valid.
const MAX_BODY_BYTES = 4096;
const ACCOUNT_LIMIT = 5;
const INGRESS_LIMIT = 120;
const INGRESS_BUCKET = 'patient-password:ingress';

const bodySchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();

class BodyTooLargeError extends SyntaxError {}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new BodyTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function invalid(): z.ZodError {
  return new z.ZodError([
    { code: 'custom', path: [], message: 'Invalid password change request' },
  ]);
}

export async function POST(request: Request): Promise<Response> {
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    requireSameOrigin(request);
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await readBoundedJson(request));
    } catch {
      throw invalid();
    }
    const withinSource = await consumeSignInBudget(
      INGRESS_BUCKET,
      INGRESS_LIMIT,
    );
    const withinAccount = await consumeSignInBudget(
      `patient-password:account:${keyDigest(patient.userId)}`,
      ACCOUNT_LIMIT,
    );
    if (!withinSource || !withinAccount) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    let changed;
    try {
      changed = await changePatientPassword(
        getPool(),
        patient.userId,
        body.currentPassword,
        body.newPassword,
      );
    } catch (error) {
      if (error instanceof PasswordPolicyError)
        return {
          status: 400,
          body: { error: 'password_policy', code: error.code },
        };
      throw error;
    }
    if (!changed.ok)
      return { status: 403, body: { error: 'current_password_invalid' } };
    await revokeOtherPatientSessions(request);
    return { status: 200, body: { status: 'changed' } };
  });
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}
