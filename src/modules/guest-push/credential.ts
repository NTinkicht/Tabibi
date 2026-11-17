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
  // The class is the stored column; the completed booking receipt join is a
  // cross-check and must agree with it.
  const klass = await pool.query<{
    credential_class: string;
    has_receipt: boolean;
  }>(
    `SELECT credential.credential_class,
            EXISTS (SELECT 1 FROM public_guest_booking_receipts receipt
                     WHERE receipt.credential_id=credential.id
                       AND receipt.clinic_id=credential.clinic_id
                       AND receipt.completed_at IS NOT NULL) AS has_receipt
       FROM guest_credentials credential
      WHERE credential.id=$1 AND credential.clinic_id=$2`,
    [credentialId, target.clinicId],
  );
  const row = klass.rows[0];
  if (!row) throw new GuestAccessRejectedError();
  const isBooking = row.credential_class === 'booking';
  if (isBooking !== row.has_receipt) throw new GuestAccessRejectedError();
  if (isBooking !== (bearer !== null)) throw new GuestAccessRejectedError();

  return {
    credentialClass: bearer !== null ? 'booking_bearer' : 'status_cookie',
    clinicId: target.clinicId,
    queueEntryId: target.queueEntryId,
  };
}
