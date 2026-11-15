import type { Pool } from 'pg';
import {
  authenticatedGuestCredentialId,
  GuestAccessRejectedError,
  GuestAccessService,
} from '@/modules/guest-access';

const STATUS_COOKIE = '__Host-tabibi_guest';

export type GuestPushCredentialClass = 'status_cookie' | 'booking_bearer';

export type GuestPushAuthentication = {
  credentialClass: GuestPushCredentialClass;
  clinicId: string;
  queueEntryId: string;
};

function statusCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === STATUS_COOKIE) return value.join('=') || null;
  }
  return null;
}

function authorizationBearer(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const bearer = authorization.slice('Bearer '.length).trim();
  return bearer.length > 0 && bearer.length <= 4096 ? bearer : null;
}

/** The credential id of whichever single class the request carries. */
export function guestPushCredentialId(request: Request): string | null {
  const presented = statusCookie(request) ?? authorizationBearer(request);
  return presented ? authenticatedGuestCredentialId(presented) : null;
}

/**
 * Authenticates a push-subscription request (docs/design/pwa-push.md section
 * 3): the exchange-origin status cookie or the booking-origin Authorization
 * bearer, never both, and neither is accepted as the other class. Every
 * failure is the one generic rejection.
 */
export async function authenticateGuestPush(
  pool: Pool,
  request: Request,
): Promise<GuestPushAuthentication> {
  const cookie = statusCookie(request);
  const bearer = authorizationBearer(request);
  if ((cookie === null) === (bearer === null))
    throw new GuestAccessRejectedError();

  const presented = (cookie ?? bearer)!;
  const credentialId = authenticatedGuestCredentialId(presented);
  if (!credentialId) throw new GuestAccessRejectedError();

  const target = await new GuestAccessService(pool).authorize(presented);
  // Booking credentials are the ones a completed booking receipt points at.
  const booking = await pool.query(
    `SELECT 1 FROM public_guest_booking_receipts
      WHERE credential_id=$1 AND clinic_id=$2 AND completed_at IS NOT NULL`,
    [credentialId, target.clinicId],
  );
  const isBooking = (booking.rowCount ?? 0) > 0;
  if (isBooking !== (bearer !== null)) throw new GuestAccessRejectedError();

  return {
    credentialClass: bearer !== null ? 'booking_bearer' : 'status_cookie',
    clinicId: target.clinicId,
    queueEntryId: target.queueEntryId,
  };
}
