import { userInfo } from 'node:os';
import { Pool } from 'pg';
import { getEnvironment } from '../../src/platform/config/env';
import { PatientAccountOperatorError } from '../../src/modules/identity/patient-account-audit';
import { issuePatientPasswordReset } from '../../src/modules/identity/patient-recovery';

// Usage: printf '%s\n' '<patient e-mail>' | \
//   PUBLIC_ORIGIN=https://tabibi.example npm run db:issue-patient-reset -- --operator '<your name>'
// Support-assisted recovery: verify the patient out of band, then hand them the
// printed link. The e-mail is read from stdin only, so it stays out of shell
// history and the process list (#972). The issuance is recorded in the account
// audit log with the operator name and the host user (#971). The token is a
// secret: it is printed once and never stored in clear. An unknown e-mail
// prints nothing secret and exits non-zero.

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// Only an origin (scheme, host, port) is accepted, https unless it is a local
// address, so the link cannot point at a path or an unencrypted public host.
function publicOrigin(value: string | undefined): string {
  if (!value)
    fail('PUBLIC_ORIGIN is not set; refusing to print a partial link.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('PUBLIC_ORIGIN is not a valid URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const scheme =
    url.protocol === 'https:' || (local && url.protocol === 'http:');
  if (!scheme || url.origin !== value.replace(/\/$/, ''))
    fail(
      'PUBLIC_ORIGIN must be an https origin with no path, e.g. https://tabibi.example',
    );
  return url.origin;
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.from(chunk as Buffer));
  return (
    Buffer.concat(chunks).toString('utf8').split(/\r?\n/u)[0] ?? ''
  ).trim();
}

function hostUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--email'))
    fail('--email is not accepted; pipe the e-mail address on stdin instead.');
  const operator = arg('operator');
  if (!operator)
    fail('Missing --operator <your name>; the issuance is audited.');
  const origin = publicOrigin(process.env.PUBLIC_ORIGIN);
  const email = await readStdinLine();
  if (!email) fail('No e-mail address on stdin.');
  const pool = new Pool({ connectionString: getEnvironment().DATABASE_URL });
  try {
    const issued = await issuePatientPasswordReset(pool, email, {
      label: operator,
      hostUser: hostUser(),
    });
    if (!issued) {
      console.error('No patient account for that e-mail address.');
      process.exitCode = 1;
      return;
    }
    console.log(
      `Reset link (single use): ${origin}/account/reset#${issued.token}`,
    );
    console.log(`Expires at ${issued.expiresAt.toISOString()}.`);
    console.log(
      `Recorded in the patient account audit log as issued by ${operator.trim()}.`,
    );
  } catch (error) {
    if (error instanceof PatientAccountOperatorError) fail(error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

void main();
