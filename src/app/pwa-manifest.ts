// TAB-PWA-1 (#883): web app manifest for the guest PWA shell. Colours come
// from docs/design/foundations.md (--tb-primary, --tb-ground).
export type ManifestLocale = 'ar' | 'fr';

export function manifestLocaleFromQuery(
  params: Pick<URLSearchParams, 'get'>,
): ManifestLocale {
  return params.get('locale') === 'ar' ? 'ar' : 'fr';
}

export function buildManifest(locale: ManifestLocale) {
  return {
    name: 'Tabibi',
    short_name: 'Tabibi',
    lang: locale,
    dir: locale === 'ar' ? 'rtl' : 'ltr',
    start_url: '/guest/status',
    scope: '/',
    display: 'standalone',
    theme_color: '#0F6E64',
    background_color: '#F4F6F3',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  } as const;
}
