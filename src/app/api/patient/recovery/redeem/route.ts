import { z } from 'zod';
import { redeemPatientPasswordReset } from '@/modules/identity/patient-recovery';
import { PasswordPolicyError } from '@/modules/identity/staff-credentials';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';
import { requireSameOrigin } from '@/platform/http/staff-auth';

// TAB-P1-01 slice 6: redeem a patient password-reset token. Same-origin first,
// bounded strict body, ingress and per-token budgets. Every unusable token
// (malformed, unknown, expired, already used) is the one 400 invalid_token. A
// policy failure is reported only for a token that is still valid and leaves it
// unconsumed. Success replaces the password and revokes every session of the
// account; no session or cookie is issued, the patient signs in again.
const MAX_BODY_BYTES = 4096;
const TOKEN_LIMIT = 5;
const INGRESS_LIMIT = 60;
const INGRESS_BUCKET = 'patient-recovery-redeem:ingress';

const bodySchema = z
  .object({
    token: z.string().min(1).max(256),
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
    { code: 'custom', path: [], message: 'Invalid recovery request' },
  ]);
}

export async function POST(request: Request): Promise<Response> {
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
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
    // Sequential on purpose: once the shared ingress budget is spent, the
    // request is refused before any per-token bucket row can be written.
    const withinToken =
      withinSource &&
      (await consumeSignInBudget(
        `patient-recovery-redeem:token:${keyDigest(body.token)}`,
        TOKEN_LIMIT,
      ));
    if (!withinSource || !withinToken) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    try {
      const result = await redeemPatientPasswordReset(
        getPool(),
        body.token,
        body.newPassword,
      );
      if (!result.ok) return { status: 400, body: { error: 'invalid_token' } };
    } catch (error) {
      if (error instanceof PasswordPolicyError)
        return {
          status: 400,
          body: { error: 'password_policy', code: error.code },
        };
      throw error;
    }
    return { status: 200, body: { status: 'changed' } };
  });
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}
