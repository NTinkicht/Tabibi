import {
  PublicGuestBookingStatusRejectedError,
  PublicGuestBookingStatusService,
} from '@/modules/public-guest-booking-status';
import { getPool } from '@/platform/database/pool';
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

export async function GET(request: Request): Promise<Response> {
  const response = await observedJson(request, async (requestId) => {
    const bearer = bearerFrom(request);
    if (!bearer) return rejected(requestId);

    try {
      const result = await new PublicGuestBookingStatusService(getPool()).get(
        bearer,
        request.signal,
      );
      return {
        body: {
          bookingState: result.bookingState,
          serviceDate: result.serviceDate,
          startsAt: result.startsAt,
          endsAt: result.endsAt,
          queueState: result.queueState,
          queueLabel: result.queueLabel,
          called: result.called,
          preferredLocale: result.preferredLocale,
        },
        status: 200,
      };
    } catch (error) {
      if (error instanceof PublicGuestBookingStatusRejectedError) {
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
