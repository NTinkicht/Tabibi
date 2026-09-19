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
  // Abort the in-flight database operation itself. abortableQuery destroys the
  // dedicated client on timeout so a stalled public SSR request cannot retain
  // shared pool capacity after this response has failed closed.
  const timer = setTimeout(() => controller.abort(), SSR_QUERY_TIMEOUT_MS);
  try {
    const clinics = await new PublicDiscoveryService(getPool()).listClinics(
      SSR_QUERY_TIMEOUT_MS,
      controller.signal,
    );
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
    clearTimeout(timer);
  }
  return <PublicDiscoveryLandingClient initialClinics={initialClinics} />;
}
