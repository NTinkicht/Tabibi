import { PublicDiscoveryService } from '@/modules/clinic';
import { getPool } from '@/platform/database/pool';
import { observedJson } from '@/platform/http/request-context';

const DISCOVERY_DEADLINE_MS = 2_000;
const PUBLIC_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

export async function GET(request: Request): Promise<Response> {
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort();
  if (request.signal.aborted) {
    controller.abort();
  } else {
    request.signal.addEventListener('abort', onRequestAbort, { once: true });
    // AbortSignal does not replay an abort that races listener registration.
    if (request.signal.aborted) controller.abort();
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      reject(new Error('Public discovery API deadline exceeded'));
    }, DISCOVERY_DEADLINE_MS);
  });

  try {
    const response = await observedJson(request, async () => {
      // Bound the HTTP response even if a query implementation ignores abort.
      // The signal also tears down real in-flight PostgreSQL work.
      const clinics = await Promise.race([
        new PublicDiscoveryService(getPool('public-discovery')).listClinics(
          undefined,
          controller.signal,
        ),
        deadline,
      ]);

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
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    request.signal.removeEventListener('abort', onRequestAbort);
  }
}
