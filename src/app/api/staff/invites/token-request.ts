import { z } from 'zod';
import { readBoundedJson } from '@/platform/http/bounded-json';
import {
  consumeStaffRateLimit,
  rateLimitDigest,
} from '@/platform/http/staff-rate-limit';

// G-18 (#824): shared guards for the two public invite routes (preview and
// accept). The token travels only in a same-origin POST body; it is never in a
// URL, never logged and never echoed back.
export const MAX_BODY_BYTES = 4096;
export const RATE_WINDOW_SECONDS = 15 * 60;
// No forwarding header is trusted, so the source limit is one deployment-wide
// ingress bucket (as for staff sign-in); a second bucket caps guessing on one
// invite id.
const INGRESS_LIMIT = 300;
const INVITE_LIMIT = 20;

export const tokenSchema = z.string().min(1).max(200);

/** Every malformed body yields the same generic 400 (no echo of its fields). */
export async function parseInviteBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  try {
    return schema.parse(await readBoundedJson(request, MAX_BODY_BYTES));
  } catch {
    throw new z.ZodError([
      { code: 'custom', path: [], message: 'Invalid invite request' },
    ]);
  }
}

export async function withinInviteRateLimit(token: string): Promise<boolean> {
  const inviteId = token.split('.', 1)[0] ?? '';
  const ingress = await consumeStaffRateLimit(
    'staff-invite:ingress',
    INGRESS_LIMIT,
    RATE_WINDOW_SECONDS,
  );
  const perInvite = await consumeStaffRateLimit(
    `staff-invite:invite:${rateLimitDigest(inviteId)}`,
    INVITE_LIMIT,
    RATE_WINDOW_SECONDS,
  );
  return ingress && perInvite;
}
