import { runRetentionSweep } from '@/modules/maintenance/retention-sweep';
import { closePool, getPool } from '@/platform/database/pool';

/**
 * One-shot TAB-P0-15 retention sweep, intended for an external scheduler
 * (cron or equivalent). Logs counts and failed task names only; exits
 * non-zero when any task failed so the scheduler can alert.
 */
async function main(): Promise<number> {
  try {
    const result = await runRetentionSweep(getPool());
    console.log(JSON.stringify({ event: 'retention.sweep', ...result }));
    return result.failed.length > 0 ? 1 : 0;
  } finally {
    await closePool();
  }
}

void main().then(
  (code) => process.exit(code),
  () => {
    console.error(JSON.stringify({ event: 'retention.sweep.fatal' }));
    process.exit(1);
  },
);
