import { describe, expect, it } from 'vitest';
import {
  PushEndpointRejectedError,
  validatePushEndpoint,
} from '../../src/modules/guest-push/endpoint-policy';
import {
  PushSubscriptionSealError,
  PushSubscriptionSealer,
  type PushSubscriptionBinding,
  type PushSubscriptionMaterial,
} from '../../src/modules/guest-push/subscription-seal';

const SECRET = 'unit-test-guest-push-seal-secret-0123456789';
const binding: PushSubscriptionBinding = {
  clinicId: 'clinic-1',
  queueEntryId: 'entry-1',
  id: 'sub-1',
};
const material: PushSubscriptionMaterial = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'BP-key_0123456789', auth: 'auth_0123456789' },
};

describe('push endpoint allow-list', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGxyz',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts %s', (endpoint) => {
    expect(validatePushEndpoint(endpoint)).toMatch(/^https:\/\//);
  });

  it.each([
    ['http scheme', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['unknown host', 'https://example.com/push/abc'],
    ['lookalike suffix', 'https://evil-fcm.googleapis.com.attacker.io/x'],
    ['lookalike prefix', 'https://notfcm.googleapis.com/x'],
    ['bare apple suffix host', 'https://push.apple.com/x'],
    ['ipv4 literal', 'https://127.0.0.1/x'],
    ['ipv6 literal', 'https://[::1]/x'],
    ['decimal ip', 'https://2130706433/x'],
    ['port', 'https://fcm.googleapis.com:8443/x'],
    ['default port written out', 'https://fcm.googleapis.com:443/x'],
    ['userinfo', 'https://user:pw@fcm.googleapis.com/x'],
    ['userinfo host trick', 'https://fcm.googleapis.com@evil.example/x'],
    ['fragment', 'https://fcm.googleapis.com/x#frag'],
    ['empty path', 'https://fcm.googleapis.com'],
    ['backslash', 'https://fcm.googleapis.com\\@evil.example/x'],
    ['whitespace', 'https://fcm.googleapis.com/x y'],
    ['empty', ''],
    ['not a string', 42],
    ['too long', `https://fcm.googleapis.com/${'a'.repeat(2100)}`],
  ])('refuses %s', (_name, endpoint) => {
    expect(() => validatePushEndpoint(endpoint)).toThrow(
      PushEndpointRejectedError,
    );
  });
});

describe('push subscription sealing', () => {
  const sealer = new PushSubscriptionSealer(SECRET);

  it('round-trips under the same binding and never leaks the endpoint', () => {
    const sealed = sealer.seal(binding, material);
    expect(sealed).not.toContain('fcm.googleapis.com');
    expect(sealed).not.toContain(material.keys.auth);
    expect(sealer.open(binding, sealed)).toEqual(material);
  });

  it.each([
    ['clinic', { ...binding, clinicId: 'clinic-2' }],
    ['entry', { ...binding, queueEntryId: 'entry-2' }],
    ['subscription id', { ...binding, id: 'sub-2' }],
  ])('rejects a different %s in the AAD', (_n, other) => {
    const sealed = sealer.seal(binding, material);
    expect(() => sealer.open(other, sealed)).toThrow(PushSubscriptionSealError);
  });

  it('rejects tampering, truncation, another secret and wrong version', () => {
    const sealed = sealer.seal(binding, material);
    const parts = sealed.split('.');
    const flipped = [...parts];
    flipped[2] = (flipped[2]![0] === 'A' ? 'B' : 'A') + flipped[2]!.slice(1);
    expect(() => sealer.open(binding, flipped.join('.'))).toThrow(
      PushSubscriptionSealError,
    );
    expect(() => sealer.open(binding, parts.slice(0, 3).join('.'))).toThrow(
      PushSubscriptionSealError,
    );
    expect(() =>
      sealer.open(binding, ['gps0', ...parts.slice(1)].join('.')),
    ).toThrow(PushSubscriptionSealError);
    const other = new PushSubscriptionSealer(
      'another-secret-of-sufficient-length-0123',
    );
    expect(() => other.open(binding, sealed)).toThrow(
      PushSubscriptionSealError,
    );
  });

  it('refuses short secrets, bad endpoints, bad keys and bad bindings', () => {
    expect(() => new PushSubscriptionSealer('short')).toThrow(
      PushSubscriptionSealError,
    );
    expect(() =>
      sealer.seal(binding, { ...material, endpoint: 'https://example.com/x' }),
    ).toThrow(PushEndpointRejectedError);
    expect(() =>
      sealer.seal(binding, {
        ...material,
        keys: { p256dh: 'not base64url!', auth: 'a' },
      }),
    ).toThrow(PushSubscriptionSealError);
    expect(() => sealer.seal({ ...binding, id: 'a|b' }, material)).toThrow(
      PushSubscriptionSealError,
    );
  });

  it('keys the endpoint hash: stable, hex, secret-dependent, not plain SHA-256', () => {
    const hash = sealer.endpointHash(material.endpoint);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sealer.endpointHash(material.endpoint)).toBe(hash);
    expect(
      new PushSubscriptionSealer(
        'another-secret-of-sufficient-length-0123',
      ).endpointHash(material.endpoint),
    ).not.toBe(hash);
    expect(() => sealer.endpointHash('https://example.com/x')).toThrow(
      PushSubscriptionSealError,
    );
  });
});
