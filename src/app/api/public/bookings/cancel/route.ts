import {
  PublicGuestBookingCancellationRejectedError,
  PublicGuestBookingCancellationService,
} from '@/modules/public-guest-booking-cancellation';
import { getPool } from '@/platform/database/pool';
import {
  PUBLIC_BOOKING_BEARER_RETRY_AFTER_SECONDS,
  bookingBearerRateLimited,
  withinPublicBookingBearerBudget,
} from '@/platform/http/public-booking-bearer-rate-limit';
import { observedJson } from '@/platform/http/request-context';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

function rejected(requestId: string): { body: unknown; status: number } {
  return {
    body: { status: 'rejected', requestId },
    status: 400,
  };
}

function bearerFrom(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const bearer = authorization.slice('Bearer '.length).trim();
  return bearer.length > 0 && bearer.length <= 4096 ? bearer : null;
}

export async function POST(request: Request): Promise<Response> {
  const response = await observedJson(request, async (requestId) => {
    const bearer = bearerFrom(request);
    if (!(await withinPublicBookingBearerBudget(getPool(), 'cancel', bearer))) {
      return bookingBearerRateLimited(requestId);
    }
    if (!bearer) return rejected(requestId);

    try {
      const result = await new PublicGuestBookingCancellationService(
        getPool(),
      ).cancel(bearer);
      return {
        body: { status: result.status },
        status: 200,
      };
    } catch (error) {
      if (error instanceof PublicGuestBookingCancellationRejectedError) {
        return rejected(requestId);
      }
      throw error;
    }
  });

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  if (response.status === 429) {
    response.headers.set(
      'retry-after',
      String(PUBLIC_BOOKING_BEARER_RETRY_AFTER_SECONDS),
    );
  }
  return response;
}
