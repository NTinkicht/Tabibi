import { PublicDiscoveryService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';
import PublicDiscoveryLandingClient, {
  type PublicClinic,
} from './PublicDiscoveryLandingClient';

// Public directory data must be in the initial HTML, not only in a JS fetch.
export const dynamic = 'force-dynamic';

const SSR_QUERY_TIMEOUT_MS = 2_000;

export default async function Home() {
  let initialClinics: PublicClinic[] | null = null;
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      reject(new Error('Public discovery SSR deadline exceeded'));
    }, SSR_QUERY_TIMEOUT_MS);
  });

  try {
    // Keep an independent response deadline even if a service implementation
    // fails to observe cancellation. The AbortSignal still cancels real DB work.
    const clinics = await Promise.race([
      new PublicDiscoveryService(getPool('public-discovery')).listClinics(
        SSR_QUERY_TIMEOUT_MS,
        controller.signal,
      ),
      deadline,
    ]);
    // Only the deliberate public allow-list crosses the server/client boundary.
    initialClinics = clinics.map((clinic) => ({
      name: clinic.name,
      defaultLocale: clinic.defaultLocale,
      enabledLocales: [...clinic.enabledLocales],
      doctors: clinic.doctors.map((doctor) => ({
        displayName: doctor.displayName,
      })),
    }));
  } catch (error) {
    getLogger().error({ err: error }, 'public discovery SSR fetch failed');
    // Keep the landing page available and allow explicit client-side retry.
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
  return <PublicDiscoveryLandingClient initialClinics={initialClinics} />;
}
