import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import {
  mapPushStatus,
  pushTopic,
  WebPushTransport,
  type PushFetch,
} from '../../src/modules/guest-push/push-transport';
import { loadVapidConfig } from '../../src/modules/guest-push/vapid-config';
import {
  checkVapid,
  decryptAes128gcm,
  newSubscriber,
  type Captured,
} from '../fixtures/fake-push-service';

const keys = webpush.generateVAPIDKeys();
const vapid = {
  publicKey: keys.publicKey,
  privateKey: keys.privateKey,
  subject: 'mailto:ops@example.org',
};
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const payload = {
  v: 1,
  kind: 'status',
  title: 'Tabibi',
  body: 'Votre tour approche',
  url: '/guest/status',
  tag: 'turn_approaching.v1',
};

function fake(status = 201, headers: Record<string, string> = {}) {
  const calls: Captured[] = [];
  const impl: PushFetch = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: init.body,
      redirect: init.redirect,
      hasSignal: init.signal instanceof AbortSignal,
    });
    return {
      status,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    };
  };
  return { calls, impl };
}

describe('Web Push transport (#886)', () => {
  it('sends VAPID-signed, aes128gcm-encrypted payload the subscriber can decrypt', async () => {
    const sub = newSubscriber(ENDPOINT);
    const { calls, impl } = fake();
    const result = await new WebPushTransport(vapid, impl).send(
      sub.subscription,
      { payload, ttlSeconds: 600, urgency: 'high', idempotencyKey: 'key-1' },
    );
    expect(result).toEqual({ kind: 'delivered' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(ENDPOINT);
    expect(call.redirect).toBe('manual');
    expect(call.hasSignal).toBe(true);
    expect(call.headers['Content-Encoding']).toBe('aes128gcm');
    expect(call.headers.TTL).toBe('600');
    expect(call.headers.Urgency).toBe('high');
    expect(call.headers.Topic).toBe(pushTopic('key-1'));
    const claims = checkVapid(call.headers.Authorization!, vapid.publicKey);
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe(vapid.subject);
    expect(decryptAes128gcm(call.body, sub)).toEqual(payload);
    // Nothing identifying travels in plaintext.
    expect(call.body.toString('utf8')).not.toContain('Tabibi');
    expect(call.body.toString('utf8')).not.toContain('guest/status');
  });

  it('derives a stable 32-char URL-safe Topic that is not the key', () => {
    const t = pushTopic('intent-id-123');
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(t).toBe(pushTopic('intent-id-123'));
    expect(t).not.toBe(pushTopic('intent-id-124'));
    expect(t).not.toContain('intent-id-123');
  });

  it.each([
    [201, { kind: 'delivered' }],
    [202, { kind: 'delivered' }],
    [404, { kind: 'gone' }],
    [410, { kind: 'gone' }],
    [400, { kind: 'rejected' }],
    [403, { kind: 'rejected' }],
    [413, { kind: 'rejected' }],
    [301, { kind: 'rejected' }],
    [429, { kind: 'unavailable' }],
    [503, { kind: 'unavailable' }],
  ])('maps push service status %i', (status, expected) => {
    expect(mapPushStatus(status, null)).toEqual(expected);
  });

  it('honours Retry-After on 429 and ignores garbage', () => {
    expect(mapPushStatus(429, '30')).toEqual({
      kind: 'unavailable',
      retryAfterSeconds: 30,
    });
    expect(mapPushStatus(503, 'soon')).toEqual({ kind: 'unavailable' });
  });

  it('never contacts a host outside the allow-list', async () => {
    const { calls, impl } = fake();
    const bad = newSubscriber(ENDPOINT);
    for (const endpoint of [
      'https://evil.example.com/push/1',
      'https://127.0.0.1/push/1',
      'https://fcm.googleapis.com:8443/fcm/send/1',
      'http://fcm.googleapis.com/fcm/send/1',
      'https://user:pw@fcm.googleapis.com/fcm/send/1',
    ]) {
      const result = await new WebPushTransport(vapid, impl).send(
        { ...bad.subscription, endpoint },
        { payload, ttlSeconds: 60, idempotencyKey: 'k' },
      );
      expect(result).toEqual({ kind: 'rejected' });
    }
    expect(calls).toHaveLength(0);
  });

  it('answers unknown on network failure or timeout without leaking detail', async () => {
    const boom: PushFetch = async () => {
      throw new Error(
        'connect ECONNREFUSED https://fcm.googleapis.com/fcm/send/abc123',
      );
    };
    const sub = newSubscriber(ENDPOINT);
    const result = await new WebPushTransport(vapid, boom).send(
      sub.subscription,
      { payload, ttlSeconds: 60, idempotencyKey: 'k' },
    );
    expect(result).toEqual({ kind: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('abc123');
  });
});

describe('VAPID configuration (#886)', () => {
  it('is absent unless all three values are present and valid', () => {
    const env = {
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: 'https://example.org/contact',
    };
    expect(loadVapidConfig(env)).toEqual({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'https://example.org/contact',
    });
    expect(loadVapidConfig({})).toBeUndefined();
    expect(
      loadVapidConfig({ ...env, VAPID_SUBJECT: undefined }),
    ).toBeUndefined();
    expect(loadVapidConfig({ ...env, VAPID_PRIVATE_KEY: '' })).toBeUndefined();
    expect(
      loadVapidConfig({ ...env, VAPID_SUBJECT: 'ftp://x' }),
    ).toBeUndefined();
    expect(
      loadVapidConfig({ ...env, VAPID_PUBLIC_KEY: 'nope' }),
    ).toBeUndefined();
  });
});
