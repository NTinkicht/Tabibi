import { describe, expect, it } from 'vitest';

import {
  pushCardState,
  pushRouteLocale,
  urlBase64ToUint8Array,
  type PushEnvironment,
} from '@/app/guest/status/guest-push-card';

const android: PushEnvironment = {
  userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130',
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  standalone: false,
  permission: 'default',
  hasSubscription: false,
};

describe('pushCardState', () => {
  it('offers activation when push is supported and undecided', () => {
    expect(pushCardState(android)).toBe('available');
  });

  it('reports a browser without PushManager, Notification or service workers as unsupported', () => {
    expect(pushCardState({ ...android, hasPushManager: false })).toBe(
      'unsupported',
    );
    expect(pushCardState({ ...android, hasNotification: false })).toBe(
      'unsupported',
    );
    expect(pushCardState({ ...android, hasServiceWorker: false })).toBe(
      'unsupported',
    );
  });

  it('reports denied permission and active subscriptions', () => {
    expect(pushCardState({ ...android, permission: 'denied' })).toBe('denied');
    expect(
      pushCardState({
        ...android,
        permission: 'granted',
        hasSubscription: true,
      }),
    ).toBe('active');
  });

  it('shows available when permission is granted but no subscription exists', () => {
    expect(pushCardState({ ...android, permission: 'granted' })).toBe(
      'available',
    );
  });

  it('asks an iPhone outside the installed app to add Tabibi to the home screen', () => {
    const iphone = {
      ...android,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)',
      hasPushManager: false,
    };
    expect(pushCardState(iphone)).toBe('ios_not_installed');
    expect(pushCardState({ ...iphone, hasPushManager: true })).toBe(
      'ios_not_installed',
    );
    expect(
      pushCardState({ ...iphone, standalone: true, hasPushManager: true }),
    ).toBe('available');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 with and without padding', () => {
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([251, 255]);
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3]);
  });

  it('rejects characters outside the URL-safe alphabet', () => {
    expect(() => urlBase64ToUint8Array('a+b/')).toThrow(TypeError);
    expect(() => urlBase64ToUint8Array('')).toThrow(TypeError);
  });
});

describe('pushRouteLocale', () => {
  it('maps English to French because the route accepts only fr or ar', () => {
    expect(pushRouteLocale('en')).toBe('fr');
    expect(pushRouteLocale('fr')).toBe('fr');
    expect(pushRouteLocale('ar')).toBe('ar');
  });
});
