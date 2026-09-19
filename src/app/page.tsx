import { PublicDiscoveryService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import { getLogger } from '@/platform/observability/logger';
import PublicDiscoveryLandingClient, {
  type PublicClinic,
} from './PublicDiscoveryLandingClient';

// Public directory data must be in the initial HTML, not only in a JS fetch.
export const dynamic = 'force-dynamic';

const SSR_QUERY_TIMEOUT_MS = 2_000;
const SSR_RESPONSE_DEADLINE_MS = 2_500;

// An independent response deadline also covers a blocked pool connection
// acquisition; the SQL query itself carries a pg per-query timeout.
async function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Public discovery SSR deadline exceeded')),
          SSR_RESPONSE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default async function Home() {
  let initialClinics: PublicClinic[] | null = null;
  try {
    const clinics = await withDeadline(
      new PublicDiscoveryService(getPool()).listClinics(SSR_QUERY_TIMEOUT_MS),
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
  }
  return <PublicDiscoveryLandingClient initialClinics={initialClinics} />;
}
