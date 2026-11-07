import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './tokens.css';
import './foundations.css';
import './styles.css';
import './wu85-accessibility.css';
import {
  LOCALE_HEADER,
  documentDirection,
  documentLocaleFromHeader,
} from './document-locale';

export const metadata: Metadata = {
  title: 'Tabibi',
  description: 'Algeria-first clinic queue management',
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = documentLocaleFromHeader((await headers()).get(LOCALE_HEADER));
  return (
    <html lang={locale} dir={documentDirection(locale)}>
      <body>{children}</body>
    </html>
  );
}
