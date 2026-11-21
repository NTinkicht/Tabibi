import { Pool } from 'pg';
import { getEnvironment } from '../../src/platform/config/env';
import {
  ClinicProvisioningError,
  provisionClinic,
  type ProvisionLocale,
} from '../../src/modules/clinic/provision';

// Usage: npm run db:create-clinic -- --tenant-key <key> --name <name>
//          [--timezone Africa/Algiers] [--locale ar|fr]
// Prints the clinic id; then run db:bootstrap-admin with it. Idempotent.
function arg(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value && required) throw new Error(`Missing --${name}`);
  return value;
}

async function main(): Promise<void> {
  const tenantKey = arg('tenant-key') as string;
  const name = arg('name') as string;
  const timezone = arg('timezone', false);
  const defaultLocale = arg('locale', false) as ProvisionLocale | undefined;
  const pool = new Pool({ connectionString: getEnvironment().DATABASE_URL });
  try {
    const result = await provisionClinic(pool, {
      tenantKey,
      name,
      timezone,
      defaultLocale,
    });
    console.log(
      result.status === 'created'
        ? `Created clinic ${result.clinicId}.`
        : `No change: tenant key already exists as clinic ${result.clinicId}.`,
    );
  } catch (error) {
    const reason =
      error instanceof ClinicProvisioningError
        ? error.message
        : (error as Error).message;
    console.error(`Provisioning refused: ${reason}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
