import type { Pool } from 'pg';
import { purgeExpiredGuestExchangeArtifacts } from '@/modules/guest-access/retention';
import { purgeExpiredPatientAuthArtifacts } from '@/modules/identity/patient-auth-retention';
import { scrubExpiredBookingReceipts } from '@/modules/public-guest-booking';
import { purgeStaleSignInRateLimitBuckets } from '@/modules/identity/rate-limit-retention';
import { purgeExpiredStaffAuthArtifacts } from '@/modules/identity/staff-auth-retention';

// TAB-P0-15 retention runner. Each purge function deletes at most one bounded
// batch per call, only verifier-class or throttling rows past their grace; this
// runner calls them all with one shared clock. A failing task never stops the
// others and is reported by task name only (no error text, rows or identifiers).
export type RetentionTaskName =
  | 'patient_auth'
  | 'staff_auth'
  | 'sign_in_rate_limit'
  | 'guest_exchange'
  | 'booking_receipt_scrub';

export interface RetentionSweepResult {
  /** Rows deleted per task that completed. */
  deleted: Partial<Record<RetentionTaskName, number>>;
  failed: RetentionTaskName[];
}

const sum = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((total, value) => total + value, 0);

export async function runRetentionSweep(
  pool: Pool,
  now: Date = new Date(),
): Promise<RetentionSweepResult> {
  const tasks: Array<[RetentionTaskName, () => Promise<number>]> = [
    [
      'patient_auth',
      async () =>
        sum({ ...(await purgeExpiredPatientAuthArtifacts(pool, now)) }),
    ],
    [
      'staff_auth',
      async () => sum({ ...(await purgeExpiredStaffAuthArtifacts(pool, now)) }),
    ],
    ['sign_in_rate_limit', () => purgeStaleSignInRateLimitBuckets(pool, now)],
    [
      'guest_exchange',
      async () =>
        sum({ ...(await purgeExpiredGuestExchangeArtifacts(pool, now)) }),
    ],
    ['booking_receipt_scrub', () => scrubExpiredBookingReceipts(pool, now)],
  ];
  const result: RetentionSweepResult = { deleted: {}, failed: [] };
  for (const [name, run] of tasks) {
    try {
      result.deleted[name] = await run();
    } catch {
      result.failed.push(name);
    }
  }
  return result;
}
