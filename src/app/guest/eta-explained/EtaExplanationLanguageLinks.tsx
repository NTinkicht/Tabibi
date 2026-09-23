'use client';

import { useSyncExternalStore } from 'react';

const ETA_SECTION_HASHES = new Set([
  '#queue-estimate-heading',
  '#consultation-estimate-heading',
  '#verification-heading',
  '#recovery-heading',
  '#privacy-heading',
]);

function subscribeHashChange(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function currentAllowedSection() {
  const hash = window.location.hash;
  return ETA_SECTION_HASHES.has(hash) ? hash : '';
}

export default function EtaExplanationLanguageLinks({
  locale,
}: {
  locale: 'fr' | 'ar';
}) {
  // The server and hydration render the same bearer-free links. Only an
  // allowlisted in-page section is added after hydration; unrelated query
  // parameters and opaque/unknown fragments are intentionally discarded.
  const section = useSyncExternalStore(
    subscribeHashChange,
    currentAllowedSection,
    () => '',
  );

  return (
    <nav aria-label={locale === 'ar' ? 'اللغة' : 'Langue'}>
      <a
        href={`?lang=fr${section}`}
        lang="fr"
        aria-current={locale === 'fr' ? 'page' : undefined}
      >
        Français
      </a>{' '}
      <a
        href={`?lang=ar${section}`}
        lang="ar"
        aria-current={locale === 'ar' ? 'page' : undefined}
      >
        العربية
      </a>
    </nav>
  );
}
