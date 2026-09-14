import { z } from 'zod';
import { PublicAvailabilitySelectionService } from '@/modules/public-availability-selection';
import {
  PublicGuestBookingRejectedError,
  PublicGuestBookingService,
  PublicGuestBookingValidationError,
} from '@/modules/public-guest-booking';
import { getPool } from '@/platform/database/pool';
import {
  correlationPattern,
  observedJson,
} from '@/platform/http/request-context';

const bodySchema = z
  .object({
    selectionReference: z.string().min(1).max(4096),
    privateDisplayName: z.string().min(1).max(120),
    contactPhone: z.string().min(3).max(32).nullable().optional(),
    contactEmail: z.string().min(3).max(254).nullable().optional(),
    preferredLocale: z.enum(['ar', 'fr']),
    contactPreference: z.enum(['none', 'phone', 'email']),
  })
  .strict();

const SECURITY_HEADERS = {
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

function rejected(requestId: string): { body: unknown; status: number } {
  return {
    body: { status: 'rejected', requestId },
    status: 400,
  };
}

export async function POST(request: Request): Promise<Response> {
  const response = await observedJson(request, async (requestId) => {
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey || !correlationPattern.test(idempotencyKey)) {
      return rejected(requestId);
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return rejected(requestId);
    }

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) return rejected(requestId);

    try {
      const pool = getPool();
      const selections = new PublicAvailabilitySelectionService(
        pool,
        publicSelectionSecret(),
      );
      const result = await new PublicGuestBookingService(pool, selections).book({
        ...parsed.data,
        idempotencyKey,
        correlationId: requestId,
      });

      return {
        body: {
          serviceDate: result.serviceDate,
          startsAt: result.startsAt,
          endsAt: result.endsAt,
          queueLabel: result.queueLabel,
          guestBearer: result.guestBearer,
          guestAccessExpiresAt: result.guestAccessExpiresAt,
        },
        status: 201,
      };
    } catch (error) {
      if (
        error instanceof PublicGuestBookingValidationError ||
        error instanceof PublicGuestBookingRejectedError
      ) {
        return rejected(requestId);
      }
      throw error;
    }
  });

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
