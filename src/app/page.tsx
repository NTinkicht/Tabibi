import { PublicDiscoveryService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import PublicDiscoveryLandingClient, {
  type PublicClinic,
} from './PublicDiscoveryLandingClient';

// Public directory data must be in the initial HTML, not only in a JS fetch.
export const dynamic = 'force-dynamic';

export default async function Home() {
  let initialClinics: PublicClinic[] | null = null;
  try {
    const clinics = await new PublicDiscoveryService(getPool()).listClinics();
    // Only the deliberate public allow-list crosses the server/client boundary.
    initialClinics = clinics.map((clinic) => ({
      name: clinic.name,
      defaultLocale: clinic.defaultLocale,
      enabledLocales: [...clinic.enabledLocales],
      doctors: clinic.doctors.map((doctor) => ({
        displayName: doctor.displayName,
      })),
    }));
  } catch {
    // Keep the landing page available and allow explicit client-side retry.
  }
  return <PublicDiscoveryLandingClient initialClinics={initialClinics} />;
}
