// docs/design/pwa-push.md sections 3 and 4: the VAPID public key the page
// needs for pushManager.subscribe(). It is public by design. Without the
// key the whole feature is off and the route answers 503.
const HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
// URL-safe base64 of an uncompressed P-256 point (65 bytes).
const VAPID_PUBLIC_KEY = /^[A-Za-z0-9_-]{86,87}$/;

export async function GET(): Promise<Response> {
  const key = process.env.VAPID_PUBLIC_KEY?.trim();
  if (!key || !VAPID_PUBLIC_KEY.test(key))
    return Response.json(
      { error: 'push_unavailable' },
      { status: 503, headers: HEADERS },
    );
  return Response.json({ publicKey: key }, { status: 200, headers: HEADERS });
}
