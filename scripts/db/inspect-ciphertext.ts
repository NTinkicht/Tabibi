import { Pool } from 'pg';
import { getEnvironment } from '../../src/platform/config/env';
import { inspectCiphertextAtRest } from './ciphertext-inspection-lib';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: getEnvironment().DATABASE_URL });
  try {
    const report = await inspectCiphertextAtRest(pool, new Date());
    console.log(JSON.stringify(report, null, 2));
    if (!report.clean) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
