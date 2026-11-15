/**
 * Push endpoint allow-list (docs/design/pwa-push.md section 3). The endpoint
 * is attacker-supplied, so it must resolve to a known push service over plain
 * HTTPS: no credentials, port, fragment, IP literal or unknown host. This is
 * the fixed SSRF boundary for the sender.
 */
const EXACT_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
]);
const SUFFIX_HOSTS = ['.push.apple.com', '.notify.windows.com'];
const MAX_ENDPOINT_LENGTH = 2048;

export class PushEndpointRejectedError extends Error {
  constructor() {
    super('Push endpoint rejected');
    this.name = 'PushEndpointRejectedError';
  }
}

function hostAllowed(host: string): boolean {
  if (EXACT_HOSTS.has(host)) return true;
  return SUFFIX_HOSTS.some(
    (suffix) =>
      host.length > suffix.length &&
      host.endsWith(suffix) &&
      /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host.slice(0, -suffix.length)),
  );
}

/** Returns the canonical endpoint URL or throws one generic error. */
export function validatePushEndpoint(endpoint: unknown): string {
  if (
    typeof endpoint !== 'string' ||
    endpoint === '' ||
    endpoint.length > MAX_ENDPOINT_LENGTH ||
    endpoint !== endpoint.trim() ||
    /[\u0000- \u007f\\]/.test(endpoint)
  ) {
    throw new PushEndpointRejectedError();
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushEndpointRejectedError();
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    endpoint.includes('#') ||
    /^https:\/\/[^/?]*:/.test(endpoint) ||
    url.pathname === '' ||
    url.pathname === '/' ||
    !hostAllowed(url.hostname)
  ) {
    throw new PushEndpointRejectedError();
  }
  return url.toString();
}
