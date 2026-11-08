import Link from 'next/link';
import type { ReactNode } from 'react';
import { guestHelpCopy } from '@/modules/localization/guest-help';
import './help-layout.css';

/** Shared guest help page frame (TAB-UI-17). Mobile-first, logical CSS only. */
export function GuestHelpShell({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <main className="tb-help" data-testid={testId}>
      {children}
    </main>
  );
}

/** One locale of a help page: card, optional back link, clinic footer. */
export function GuestHelpSection({
  locale,
  labelledBy,
  children,
  backLink = true,
}: {
  locale: 'fr' | 'ar';
  labelledBy: string;
  children: ReactNode;
  backLink?: boolean;
}) {
  const copy = guestHelpCopy[locale];
  return (
    <section
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      aria-labelledby={labelledBy}
      className="tb-help__card"
    >
      {backLink ? (
        <Link href="/guest/help" className="tb-help__back">
          {copy.back}
        </Link>
      ) : null}
      {children}
      <footer className="tb-help__footer">
        <strong>{copy.clinicHelpTitle}</strong>
        <span>{copy.clinicHelpBody}</span>
      </footer>
    </section>
  );
}
