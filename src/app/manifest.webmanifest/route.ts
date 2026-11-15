import { buildManifest, manifestLocaleFromQuery } from '../pwa-manifest';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const locale = manifestLocaleFromQuery(new URL(request.url).searchParams);
  return new Response(JSON.stringify(buildManifest(locale)), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
