import { Pool } from 'pg';
import { getEnvironment } from '../../src/platform/config/env';
import { issuePatientPasswordReset } from '../../src/modules/identity/patient-recovery';

// Usage: npm run db:issue-patient-reset -- --email <patient e-mail>
// Support-assisted recovery: verify the patient out of band, then hand them the
// printed link. The token is a secret: it is printed once and never stored in
// clear. An unknown e-mail prints nothing secret and exits non-zero.
async function main(): Promise<void> {
  const index = process.argv.indexOf('--email');
  const email = index >= 0 ? process.argv[index + 1] : undefined;
  if (!email) throw new Error('Missing --email');
  const pool = new Pool({ connectionString: getEnvironment().DATABASE_URL });
  try {
    const issued = await issuePatientPasswordReset(pool, email);
    if (!issued) {
      console.error('No patient account for that e-mail address.');
      process.exitCode = 1;
      return;
    }
    console.log(`Reset link (single use): /account/reset#${issued.token}`);
    console.log(`Expires at ${issued.expiresAt.toISOString()}.`);
  } finally {
    await pool.end();
  }
}

void main();
