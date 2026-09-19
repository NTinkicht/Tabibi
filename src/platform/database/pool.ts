import { Pool } from 'pg';
import { getEnvironment } from '@/platform/config/env';

let pool: Pool | undefined;
let publicDiscoveryPool: Pool | undefined;

export function getPool(scope?: 'public-discovery'): Pool {
  if (scope === 'public-discovery') {
    publicDiscoveryPool ??= new Pool({
      connectionString: getEnvironment().DATABASE_URL,
      max: 10,
      // Public discovery is intentionally fail-fast under saturation so an
      // unauthenticated landing-page request cannot outlive its SSR/API budget.
      connectionTimeoutMillis: 400,
    });
    return publicDiscoveryPool;
  }

  // Operational booking, guest, staff, and readiness paths retain the shared
  // pool's established checkout behavior. Public-page latency policy must not
  // silently tighten these higher-value workflows.
  pool ??= new Pool({
    connectionString: getEnvironment().DATABASE_URL,
    max: 10,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  const pools = [pool, publicDiscoveryPool].filter(
    (candidate): candidate is Pool => candidate !== undefined,
  );
  await Promise.all(pools.map((candidate) => candidate.end()));
  pool = undefined;
  publicDiscoveryPool = undefined;
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
