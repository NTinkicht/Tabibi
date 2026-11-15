import { z } from 'zod';
import {
  PatientRegistrationInputError,
  normalizePatientEmail,
  registerPatientAccount,
} from '@/modules/identity/patient-credentials';
import { PasswordPolicyError } from '@/modules/identity/staff-credentials';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';
import { requireSameOrigin } from '@/platform/http/staff-auth';

// TAB-P1-01 slice 3: patient registration. Same-origin first, bounded strict
// body. A new email and an already-registered email get the byte-identical 202
// and no session or cookie is ever issued here, so the route cannot be used to
// enumerate accounts or take one over. Input errors depend only on the request.
const MAX_BODY_BYTES = 4096;
const EMAIL_LIMIT = 5;
const INGRESS_LIMIT = 60;
const INGRESS_BUCKET = 'patient-register:ingress';

const bodySchema = z
  .object({
    email: z.string().min(1).max(320),
    displayName: z.string().min(1).max(640),
    password: z.string().min(1).max(1024),
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
    { code: 'custom', path: [], message: 'Invalid registration request' },
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
    const email = normalizePatientEmail(body.email);
    const emailKey = keyDigest(email ?? body.email.normalize('NFKC'));
    const withinSource = await consumeSignInBudget(
      INGRESS_BUCKET,
      INGRESS_LIMIT,
    );
    const withinEmail = await consumeSignInBudget(
      `patient-register:email:${emailKey}`,
      EMAIL_LIMIT,
    );
    if (!withinSource || !withinEmail) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    try {
      await registerPatientAccount(getPool(), body);
    } catch (error) {
      if (
        error instanceof PatientRegistrationInputError ||
        error instanceof PasswordPolicyError
      )
        throw invalid();
      throw error;
    }
    return { status: 202, body: { status: 'accepted' } };
  });
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}
