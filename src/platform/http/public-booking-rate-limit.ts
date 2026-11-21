import {
  SIGN_IN_RATE_WINDOW_SECONDS,
  consumeSignInBudget,
  keyDigest,
} from '@/platform/http/sign-in-rate-limit';

// TAB-P0-15 / TAB-P1-07 abuse control for the unauthenticated booking route.
// Two fixed-window budgets share the sign-in bucket table, keyed only by
// digests so no contact value or selection reference is stored:
//  - per contact: bounds how many confirmations one phone or e-mail can be made
//    to receive, whoever submits them;
//  - per selection reference: bounds repeated attempts against one offered slot.
// There is deliberately no global budget: it would let one client lock every
// patient out. A third party can still exhaust a victim contact's budget for the
// window, which only blocks booking with that contact value (fail closed).
export const PUBLIC_BOOKING_CONTACT_LIMIT = 10;
export const PUBLIC_BOOKING_SELECTION_LIMIT = 30;
export const PUBLIC_BOOKING_RETRY_AFTER_SECONDS = SIGN_IN_RATE_WINDOW_SECONDS;

function contactKeys(
  contactPhone: string | null | undefined,
  contactEmail: string | null | undefined,
): string[] {
  const keys: string[] = [];
  const phone = contactPhone?.replace(/[^\d+]/g, '');
  if (phone) keys.push(`public-booking:phone:${keyDigest(phone)}`);
  const email = contactEmail?.normalize('NFKC').trim().toLowerCase();
  if (email) keys.push(`public-booking:email:${keyDigest(email)}`);
  return keys;
}

// Buffer.from(_, 'base64url') ignores stray characters and non-canonical
// trailing bits, so many spellings decode to one selection. Key on the decoded
// bytes re-encoded canonically; any reference of another shape shares one
// fixed bucket (it can never resolve, so it cannot lock out a real slot).
function selectionBudgetKey(reference: string): string {
  const parts = reference.split('.');
  if (parts.length !== 4) return 'public-booking:selection:malformed';
  const [version, ...encoded] = parts;
  const canonical = [
    version,
    ...encoded.map((part) =>
      Buffer.from(part, 'base64url').toString('base64url'),
    ),
  ].join('.');
  return `public-booking:selection:${keyDigest(canonical)}`;
}

/** Returns false when any applicable budget is exhausted. */
export async function withinPublicBookingBudget(input: {
  selectionReference: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
}): Promise<boolean> {
  let allowed = await consumeSignInBudget(
    selectionBudgetKey(input.selectionReference),
    PUBLIC_BOOKING_SELECTION_LIMIT,
  );
  for (const key of contactKeys(input.contactPhone, input.contactEmail)) {
    // Every budget is consumed so one exhausted key cannot hide the others.
    allowed =
      (await consumeSignInBudget(key, PUBLIC_BOOKING_CONTACT_LIMIT)) && allowed;
  }
  return allowed;
}
