'use client';

import { useEffect } from 'react';

import { registerGuestServiceWorker } from './guest-service-worker-register';

// TAB-PWA-1 (#883): registers the push-only service worker and links the
// manifest. Rendered only by guest pages; staff pages never include it.
export function GuestServiceWorker() {
  useEffect(() => {
    const locale = document.documentElement.lang === 'ar' ? 'ar' : 'fr';
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = `/manifest.webmanifest?locale=${locale}`;
      document.head.appendChild(link);
    }
    void registerGuestServiceWorker(
      'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    );
  }, []);
  return null;
}
