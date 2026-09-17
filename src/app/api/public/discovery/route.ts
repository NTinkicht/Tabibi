import { PublicDiscoveryService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import { observedJson } from '@/platform/http/request-context';

const PUBLIC_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

export async function GET(request: Request): Promise<Response> {
  const response = await observedJson(request, async () => {
    const clinics = await new PublicDiscoveryService(getPool()).listClinics();

    return {
      status: 200,
      body: {
        clinics: clinics.map((clinic) => ({
          name: clinic.name,
          defaultLocale: clinic.defaultLocale,
          enabledLocales: clinic.enabledLocales,
          doctors: clinic.doctors.map((doctor) => ({
            displayName: doctor.displayName,
          })),
        })),
      },
    };
  });

  for (const [name, value] of Object.entries(PUBLIC_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
