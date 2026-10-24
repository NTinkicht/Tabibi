import { operationalJson } from '@/platform/http/operational-response';
import {
  CLEARED_STAFF_SESSION_COOKIE,
  requireSameOrigin,
  revokeStaffSession,
} from '@/platform/http/staff-auth';

// TAB-P0-01 (#634, owner decision A): staff logout revokes the server-side
// session row, so the old token is rejected on every staff route at once,
// and expires the browser cookie. Same-origin is required before any work.
export async function POST(request: Request): Promise<Response> {
  const response = await operationalJson(request, async () => {
    requireSameOrigin(request);
    await revokeStaffSession(request);
    return { status: 200, body: { loggedOut: true } };
  });
  if (response.status === 200)
    response.headers.append('set-cookie', CLEARED_STAFF_SESSION_COOKIE);
  return response;
}
