import { Pool } from 'pg';
import { getEnvironment } from '../../src/platform/config/env';
import { bootstrapFirstClinicAdmin } from '../../src/modules/identity/bootstrap-admin';
import { PasswordPolicyError } from '../../src/modules/identity/staff-credentials';

// Usage: npm run db:bootstrap-admin -- --clinic-id <uuid> --email <email> --display-name <name>
// The password is read from stdin only (never argv or env) and is never printed.
function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  const clinicId = arg('clinic-id');
  const email = arg('email');
  const displayName = arg('display-name');
  const password = await readStdin();
  const pool = new Pool({ connectionString: getEnvironment().DATABASE_URL });
  try {
    const result = await bootstrapFirstClinicAdmin(pool, {
      clinicId,
      email,
      displayName,
      password,
    });
    console.log(
      result.status === 'created'
        ? `Created the first clinic_admin for clinic ${clinicId}.`
        : `No change: clinic ${clinicId} already has a clinic_admin.`,
    );
  } catch (error) {
    // Only the error class and a safe message; the password is never echoed.
    const reason =
      error instanceof PasswordPolicyError
        ? `weak password (${error.code})`
        : (error as Error).message;
    console.error(`Bootstrap refused: ${reason}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
