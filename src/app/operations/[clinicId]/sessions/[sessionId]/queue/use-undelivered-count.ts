'use client';

import { useEffect, useState } from 'react';

/**
 * Count of undelivered notifications (dead letters plus guest-link failures)
 * for the clinic. Unknown or failed reads count as zero: the alert is shown
 * only when a positive count was actually returned by the server.
 */
export function useUndeliveredCount(clinicId: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const base = `/api/clinics/${clinicId}/notifications`;
    const size = async (url: string, field: string): Promise<number> => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) return 0;
        const body = (await response.json()) as Record<string, unknown> | null;
        const list = body?.[field];
        return Array.isArray(list) ? list.length : 0;
      } catch {
        return 0;
      }
    };
    const run = () =>
      void Promise.all([
        size(`${base}/dead-letters?limit=100`, 'deadLetters'),
        size(`${base}/guest-link-failures?limit=100`, 'failures'),
      ]).then(([dead, guest]) => {
        if (alive) setCount(dead + guest);
      });
    run();
    const timer = window.setInterval(run, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [clinicId]);
  return count;
}
