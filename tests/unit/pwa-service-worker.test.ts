import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { registerGuestServiceWorker } from '@/app/guest-service-worker-register';
import { buildManifest, manifestLocaleFromQuery } from '@/app/pwa-manifest';

type Listener = (event: unknown) => void;

function loadWorker() {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const focused: string[] = [];
  let windows: Array<{ url: string; focus: () => Promise<void> }> = [];
  const self = {
    location: { origin: 'https://tabibi.test' },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
      pushManager: { subscribe: () => Promise.reject(new Error('unused')) },
    },
    clients: {
      matchAll: () => Promise.resolve(windows),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
  };
  const source = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
  runInNewContext(source, {
    self,
    URL,
    fetch: () => Promise.reject(new Error('no')),
  });
  return {
    listeners,
    shown,
    opened,
    focused,
    setWindows: (urls: string[]) => {
      windows = urls.map((url) => ({
        url,
        focus: () => {
          focused.push(url);
          return Promise.resolve();
        },
      }));
    },
  };
}

async function dispatch(
  worker: ReturnType<typeof loadWorker>,
  type: string,
  event: Record<string, unknown>,
) {
  const pending: Promise<unknown>[] = [];
  worker.listeners.get(type)!({
    ...event,
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  await Promise.all(pending);
}

const pushEvent = (payload: unknown) => ({
  data: { json: () => payload },
});

describe('guest service worker (TAB-PWA-1)', () => {
  it('registers only push, notificationclick and pushsubscriptionchange', () => {
    const w = loadWorker();
    expect([...w.listeners.keys()].sort()).toEqual([
      'notificationclick',
      'push',
      'pushsubscriptionchange',
    ]);
    expect(w.listeners.has('fetch')).toBe(false);
  });

  it('never references Cache Storage or a fetch handler', () => {
    const source = readFileSync(
      resolve(__dirname, '../../public/sw.js'),
      'utf8',
    );
    expect(source).not.toMatch(/\bcaches\b/);
    expect(source).not.toMatch(/addEventListener\(\s*'fetch'/);
  });

  it('shows the payload title and body', async () => {
    const w = loadWorker();
    await dispatch(
      w,
      'push',
      pushEvent({
        v: 1,
        kind: 'status',
        title: 'Tabibi',
        body: 'Votre tour approche',
        url: '/guest/status',
        tag: 'turn_approaching',
      }),
    );
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.title).toBe('Tabibi');
    expect(w.shown[0]!.options).toMatchObject({
      body: 'Votre tour approche',
      tag: 'turn_approaching',
      lang: 'fr',
      dir: 'ltr',
      data: { url: '/guest/status' },
    });
  });

  it('marks Arabic bodies rtl and ignores malformed payloads', async () => {
    const w = loadWorker();
    await dispatch(
      w,
      'push',
      pushEvent({ v: 1, kind: 'link', title: 'Tabibi', body: 'يقترب دورك' }),
    );
    expect(w.shown[0]!.options).toMatchObject({ lang: 'ar', dir: 'rtl' });
    for (const bad of [
      null,
      'text',
      { v: 2, kind: 'status', body: 'x' },
      { v: 1, kind: 'other', body: 'x' },
      { v: 1, kind: 'status' },
    ]) {
      await dispatch(w, 'push', pushEvent(bad));
    }
    expect(w.shown).toHaveLength(1);
  });

  it('rewrites a disallowed payload url to /guest/status when shown', async () => {
    const w = loadWorker();
    await dispatch(
      w,
      'push',
      pushEvent({ v: 1, kind: 'link', body: 'x', url: 'https://evil.test/a' }),
    );
    expect(w.shown[0]!.options).toMatchObject({
      data: { url: '/guest/status' },
    });
  });

  const click = (w: ReturnType<typeof loadWorker>, url: unknown) =>
    dispatch(w, 'notificationclick', {
      notification: { close: () => undefined, data: { url } },
    });

  it('notificationclick opens only allow-listed same-origin urls', async () => {
    const w = loadWorker();
    await click(w, '/api/guest/exchange/abc123?x=1');
    await click(w, 'https://tabibi.test/guest/status?locale=fr');
    for (const bad of [
      'https://evil.test/guest/status',
      '//evil.test/guest/status',
      '/operations',
      '/guest/statusx',
      '/api/guest/exchange/../../staff',
      'javascript:alert(1)',
      'https://u:p@tabibi.test/guest/status',
      '',
      undefined,
      42,
    ]) {
      await click(w, bad);
    }
    expect(w.opened).toEqual([
      '/api/guest/exchange/abc123?x=1',
      '/guest/status?locale=fr',
      ...Array(10).fill('/guest/status'),
    ]);
  });

  it('notificationclick focuses an open status window instead of opening', async () => {
    const w = loadWorker();
    w.setWindows(['https://tabibi.test/guest/status']);
    await click(w, '/guest/status');
    expect(w.focused).toEqual(['https://tabibi.test/guest/status']);
    expect(w.opened).toEqual([]);
    await click(w, '/api/guest/exchange/abc');
    expect(w.opened).toEqual(['/api/guest/exchange/abc']);
  });
});

describe('PWA manifest (TAB-PWA-1)', () => {
  it('defaults to fr ltr and serves ar rtl on request', () => {
    expect(manifestLocaleFromQuery(new URLSearchParams())).toBe('fr');
    expect(manifestLocaleFromQuery(new URLSearchParams('locale=zz'))).toBe(
      'fr',
    );
    expect(manifestLocaleFromQuery(new URLSearchParams('locale=ar'))).toBe(
      'ar',
    );
    expect(buildManifest('fr')).toMatchObject({
      lang: 'fr',
      dir: 'ltr',
      start_url: '/guest/status',
      scope: '/',
      display: 'standalone',
      theme_color: '#0F6E64',
      background_color: '#F4F6F3',
    });
    expect(buildManifest('ar')).toMatchObject({ lang: 'ar', dir: 'rtl' });
    const purposes = buildManifest('fr').icons.map((i) => i.sizes);
    expect(purposes).toEqual(['192x192', '512x512', '512x512']);
  });
});

describe('service worker registration (TAB-PWA-1)', () => {
  it('registers /sw.js with root scope and reports success', async () => {
    const calls: unknown[][] = [];
    const warnings: string[] = [];
    const ok = await registerGuestServiceWorker(
      { register: (...a) => (calls.push(a), Promise.resolve({})) },
      (m) => warnings.push(m),
    );
    expect(ok).toBe(true);
    expect(calls).toEqual([['/sw.js', { scope: '/' }]]);
    expect(warnings).toEqual([]);
  });

  it('warns with the error name only when registration fails', async () => {
    const warnings: string[] = [];
    const err = new Error('secret-token-in-message');
    err.name = 'SecurityError';
    const ok = await registerGuestServiceWorker(
      { register: () => Promise.reject(err) },
      (m) => warnings.push(m),
    );
    expect(ok).toBe(false);
    expect(warnings).toEqual([
      'Guest service worker registration failed: SecurityError',
    ]);
  });

  it('is a quiet no-op when service workers are unsupported', async () => {
    const warnings: string[] = [];
    expect(
      await registerGuestServiceWorker(undefined, (m) => warnings.push(m)),
    ).toBe(false);
    expect(warnings).toEqual([]);
  });
});
