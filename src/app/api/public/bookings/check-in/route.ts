import {
  PublicGuestBookingCheckInRejectedError,
  PublicGuestBookingCheckInService,
  PublicGuestBookingCheckInValidationError,
} from '@/modules/public-guest-booking-check-in';
import { getPool } from '@/platform/database/pool';
import { observedJson } from '@/platform/http/request-context';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

function rejected(): { body: unknown; status: number } {
  return { body: { error: 'guest_check_in_unavailable' }, status: 404 };
}

function invalidRequest(): { body: unknown; status: number } {
  return { body: { error: 'invalid_request' }, status: 400 };
}

function transientFailure(): { body: unknown; status: number } {
  return { body: { error: 'temporarily_unavailable' }, status: 503 };
}

function bearerFrom(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const bearer = authorization.slice('Bearer '.length).trim();
  return bearer.length > 0 && bearer.length <= 4096 ? bearer : null;
}

async function operationIdFrom(request: Request): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = (parsed as { operationId?: unknown }).operationId;
  return typeof candidate === 'string' ? candidate : null;
}

export async function POST(request: Request): Promise<Response> {
  const response = await observedJson(request, async () => {
    const bearer = bearerFrom(request);
    if (!bearer) return rejected();

    const operationId = await operationIdFrom(request);
    if (operationId === null) return invalidRequest();

    try {
      const result = await new PublicGuestBookingCheckInService(
        getPool(),
      ).checkIn(bearer, operationId);
      return {
        body: { state: result.status, reconciled: result.reconciled },
        status: 200,
      };
    } catch (error) {
      if (error instanceof PublicGuestBookingCheckInValidationError) {
        return invalidRequest();
      }
      if (error instanceof PublicGuestBookingCheckInRejectedError) {
        return rejected();
      }
      return transientFailure();
    }
  });

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
