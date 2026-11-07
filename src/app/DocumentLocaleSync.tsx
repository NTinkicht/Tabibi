'use client';

import { useEffect } from 'react';
import { documentDirection, type DocumentLocale } from './document-locale';

// TAB-UI-01b: mirror the active client-side locale onto <html lang/dir> so the
// direction and font stack (html[lang='ar'] token) follow in-page switches.
export function applyDocumentLocale(
  root: { lang: string; dir: string },
  locale: DocumentLocale,
): void {
  root.lang = locale;
  root.dir = documentDirection(locale);
}

export function DocumentLocaleSync({ locale }: { locale: DocumentLocale }) {
  useEffect(() => {
    applyDocumentLocale(document.documentElement, locale);
  }, [locale]);
  return null;
}
