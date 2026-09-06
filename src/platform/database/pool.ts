import { Pool } from 'pg';
import { getEnvironment } from '@/platform/config/env';

let pool: Pool | undefined;

export function getPool(): Pool {
  pool ??= new Pool({
    connectionString: getEnvironment().DATABASE_URL,
    max: 10,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
}

export async function databaseIsReady(): Promise<boolean> {
  try {
    const result = await getPool().query<{ ready: number }>(
      'SELECT 1 AS ready',
    );
    return result.rows[0]?.ready === 1;
  } catch (error) {
    getLogger().error({ err: error }, 'database readiness check failed');
    return false;
  }
}

import { getLogger } from '@/platform/observability/logger';
