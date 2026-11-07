// TAB-UI-01: root <html lang/dir> from the locale source pages already use
// (`lang` on the waiting room, `locale` elsewhere; anything but `fr` is `ar`).
export const LOCALE_HEADER = 'x-tabibi-locale';

export type DocumentLocale = 'ar' | 'fr';

export function documentLocaleFromQuery(
  params: Pick<URLSearchParams, 'get'>,
): DocumentLocale {
  return (params.get('lang') ?? params.get('locale')) === 'fr' ? 'fr' : 'ar';
}

export function documentLocaleFromHeader(
  value: string | null | undefined,
): DocumentLocale {
  return value === 'fr' ? 'fr' : 'ar';
}

export function documentDirection(locale: DocumentLocale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
