import { PublicBookableSessionService } from '@/modules/public-availability';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import { parseDiscoveryFilters } from '@/platform/http/discovery-input';
import { getPool } from '@/platform/database/pool';
import { observedJson } from '@/platform/http/request-context';

const BOOKABLE_SESSIONS_DEADLINE_MS = 2_000;
const PUBLIC_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

function publicSelectionSecret(): string {
  const secret = process.env.PUBLIC_AVAILABILITY_SELECTION_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(
      'PUBLIC_AVAILABILITY_SELECTION_SECRET must be configured with at least 32 bytes',
    );
  }
  return secret;
}

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
      reject(new Error('Public bookable sessions API deadline exceeded'));
    }, BOOKABLE_SESSIONS_DEADLINE_MS);
  });

  try {
    const response = await observedJson(request, async (requestId) => {
      // TAB-P0-03 (#803): the discovery filters (same rules as discovery:
      // unknown or repeated keys and codes outside the controlled lists are
      // refused). `available` is meaningless here (every result is bookable)
      // and is refused too.
      const parsed = parseDiscoveryFilters(request.url);
      if (parsed === null || parsed.availableOnly !== undefined) {
        return { status: 400, body: { status: 'rejected', requestId } };
      }
      const { page = 1, ...filters } = parsed;
      // Fail closed before any query when the sealing secret is unusable.
      const pool = getPool('public-discovery');
      const sealer = new PublicAvailabilitySelectionService(
        pool,
        publicSelectionSecret(),
      );
      const { clinics, hasMore } = await Promise.race([
        new PublicBookableSessionService(pool, sealer).listPage(
          controller.signal,
          filters,
          page,
        ),
        deadline,
      ]);

      // Only the deliberate public allow-list is serialized.
      return {
        status: 200,
        body: {
          clinics: clinics.map((clinic) => ({
            name: clinic.name,
            defaultLocale: clinic.defaultLocale,
            enabledLocales: clinic.enabledLocales,
            wilayaCode: clinic.wilayaCode,
            commune: clinic.commune,
            addressLine: clinic.addressLine,
            doctors: clinic.doctors.map((doctor) => ({
              displayName: doctor.displayName,
              specialtyCodes: [...doctor.specialtyCodes],
              sessions: doctor.sessions.map((session) => ({
                serviceDate: session.serviceDate,
                startsAt: session.startsAt,
                endsAt: session.endsAt,
                selectionReference: session.selectionReference,
              })),
            })),
          })),
          page,
          hasMore: hasMore === true,
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
