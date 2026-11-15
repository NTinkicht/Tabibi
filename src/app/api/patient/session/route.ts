import { z } from 'zod';
import {
  normalizePatientEmail,
  verifyPatientPassword,
} from '@/modules/identity/patient-credentials';
import { getPool } from '@/platform/database/pool';
import { operationalJson } from '@/platform/http/operational-response';
import {
  authenticatedPatient,
  createPatientSessionToken,
  patientSessionSetCookie,
  revokePatientSession,
} from '@/platform/http/patient-auth';
import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';
import {
  StaffAuthenticationError,
  requireSameOrigin,
} from '@/platform/http/staff-auth';

// TAB-P1-01 slice 2: patient sign-in (POST) and current-account read (GET).
// Same-origin first, bounded strict body, one generic 400 for any malformed
// input, and unknown account, wrong password and locked account all return the
// one 401 shape from the credential service.
const MAX_BODY_BYTES = 4096;
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const ACCOUNT_LIMIT = 10;
const INGRESS_LIMIT = 300;
const INGRESS_BUCKET = 'patient-signin:ingress';

const bodySchema = z
  .object({
    email: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
  })
  .strict();

class BodyTooLargeError extends SyntaxError {}

function sessionTtlSeconds(): number {
  const raw = Number(process.env.PATIENT_SESSION_TTL_SECONDS);
  if (!Number.isInteger(raw)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, raw));
}

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

async function parseBody(
  request: Request,
): Promise<z.infer<typeof bodySchema>> {
  try {
    return bodySchema.parse(await readBoundedJson(request));
  } catch {
    throw new z.ZodError([
      { code: 'custom', path: [], message: 'Invalid sign-in request' },
    ]);
  }
}

export async function GET(request: Request): Promise<Response> {
  return operationalJson(request, async () => {
    const patient = await authenticatedPatient(request);
    return {
      status: 200,
      body: { account: { displayName: patient.displayName } },
    };
  });
}

export async function POST(request: Request): Promise<Response> {
  let setCookie: string | null = null;
  let rateLimited = false;
  const response = await operationalJson(request, async () => {
    requireSameOrigin(request);
    const body = await parseBody(request);
    const email = normalizePatientEmail(body.email);
    const accountKey = keyDigest(email ?? body.email.normalize('NFKC'));
    const withinSource = await consumeSignInBudget(
      INGRESS_BUCKET,
      INGRESS_LIMIT,
    );
    const withinAccount = await consumeSignInBudget(
      `patient-signin:account:${accountKey}`,
      ACCOUNT_LIMIT,
    );
    if (!withinSource || !withinAccount) {
      rateLimited = true;
      return { status: 429, body: { error: 'rate_limited' } };
    }
    const verified = await verifyPatientPassword(
      getPool(),
      body.email,
      body.password,
    );
    if (!verified.ok) throw new StaffAuthenticationError();
    // A new sign-in replaces the session carried by the request.
    await revokePatientSession(request);
    const ttl = sessionTtlSeconds();
    const token = await createPatientSessionToken(
      verified.userId,
      new Date(Date.now() + ttl * 1000),
    );
    setCookie = patientSessionSetCookie(token, ttl);
    const account = await getPool().query<{ display_name: string }>(
      'SELECT display_name FROM users WHERE id = $1',
      [verified.userId],
    );
    return {
      status: 200,
      body: { account: { displayName: account.rows[0]?.display_name ?? '' } },
    };
  });
  if (setCookie && response.status === 200)
    response.headers.append('set-cookie', setCookie);
  if (rateLimited)
    response.headers.set('retry-after', String(SIGN_IN_RATE_WINDOW_SECONDS));
  return response;
}
