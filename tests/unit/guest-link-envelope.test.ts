import { createDecipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EXCHANGE_TTL_MS,
  GuestLinkEnvelope,
  GuestLinkEnvelopeError,
  type GuestLinkBinding,
} from '../../src/modules/guest-access/link-envelope';

const SECRET = 'unit-test-guest-link-envelope-secret-0123456789';
const MATERIAL = 'https://tabibi.example/g/EXCHANGE-ID-SECRET-abc123';
const binding: GuestLinkBinding = {
  intent: 'initial',
  entryId: 'entry-1',
  clinicId: 'clinic-1',
};

function envelope(now = { t: 1_000_000 }, ttl?: number) {
  return {
    now,
    env: new GuestLinkEnvelope(SECRET, () => new Date(now.t), ttl),
  };
}

describe('GuestLinkEnvelope', () => {
  it('round-trips for the exact binding and never stores plaintext', () => {
    const { env } = envelope();
    const sealed = env.seal(binding, MATERIAL);
    expect(env.open(binding, sealed)).toBe(MATERIAL);
    expect(sealed).not.toContain('EXCHANGE-ID-SECRET');
    expect(sealed).not.toContain('tabibi.example');
    expect(Buffer.from(sealed, 'utf8').toString('base64')).not.toContain(
      Buffer.from(MATERIAL).toString('base64'),
    );
  });

  it('rejects any AAD binding drift (intent, entry, clinic)', () => {
    const { env } = envelope();
    const sealed = env.seal(binding, MATERIAL);
    for (const drift of [
      { ...binding, intent: 'resend' as const },
      { ...binding, intent: 'transfer' as const },
      { ...binding, entryId: 'entry-2' },
      { ...binding, clinicId: 'clinic-2' },
    ]) {
      expect(() => env.open(drift, sealed)).toThrow(GuestLinkEnvelopeError);
    }
  });

  it('rejects tampered version, iv, ciphertext and tag segments', () => {
    const { env } = envelope();
    const parts = env.seal(binding, MATERIAL).split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (let i = 0; i < 4; i++) {
      const bad = [...parts];
      bad[i] = i === 0 ? 'gle0' : flip(parts[i]!);
      expect(() => env.open(binding, bad.join('.'))).toThrow(
        GuestLinkEnvelopeError,
      );
    }
    expect(() => env.open(binding, 'garbage')).toThrow(GuestLinkEnvelopeError);
    expect(() => env.open(binding, '')).toThrow(GuestLinkEnvelopeError);
  });

  it('fails closed with the wrong key', () => {
    const sealed = envelope().env.seal(binding, MATERIAL);
    const other = new GuestLinkEnvelope(
      'a-completely-different-secret-0123456789abcdef',
      () => new Date(1_000_000),
    );
    expect(() => other.open(binding, sealed)).toThrow(GuestLinkEnvelopeError);
  });

  it('refuses a missing or short key without a plaintext fallback', () => {
    for (const secret of ['', 'short', undefined as unknown as string]) {
      expect(() => new GuestLinkEnvelope(secret)).toThrow(
        GuestLinkEnvelopeError,
      );
    }
  });

  it('expires at the TTL boundary and never exceeds the exchange TTL', () => {
    const { env, now } = envelope();
    const sealed = env.seal(binding, MATERIAL);
    now.t += EXCHANGE_TTL_MS - 1;
    expect(env.open(binding, sealed)).toBe(MATERIAL);
    now.t += 1;
    expect(() => env.open(binding, sealed)).toThrow(GuestLinkEnvelopeError);

    for (const ttl of [0, -1, NaN, EXCHANGE_TTL_MS + 1]) {
      expect(() => envelope({ t: 0 }, ttl)).toThrow(GuestLinkEnvelopeError);
    }
  });

  it('rejects invalid bindings and empty material on seal', () => {
    const { env } = envelope();
    expect(() => env.seal({ ...binding, entryId: '' }, MATERIAL)).toThrow(
      GuestLinkEnvelopeError,
    );
    expect(() => env.seal({ ...binding, clinicId: '' }, MATERIAL)).toThrow(
      GuestLinkEnvelopeError,
    );
    expect(() =>
      env.seal({ ...binding, intent: 'bogus' as never }, MATERIAL),
    ).toThrow(GuestLinkEnvelopeError);
    expect(() => env.seal(binding, '')).toThrow(GuestLinkEnvelopeError);
  });

  it('uses a domain-separated key, distinct from a plain secret hash', () => {
    // A selection/receipt-style key is sha256(secret); an envelope sealed by
    // this module must not open under that key (key isolation).
    const sealed = envelope().env.seal(binding, MATERIAL);
    const plainHashKey = createHash('sha256').update(SECRET, 'utf8').digest();
    expect(plainHashKey.length).toBe(32);

    const [, iv, ct, tag] = sealed.split('.');
    const d = createDecipheriv(
      'aes-256-gcm',
      plainHashKey,
      Buffer.from(iv!, 'base64url'),
    );
    d.setAAD(
      Buffer.from(JSON.stringify(['gle1', 'initial', 'entry-1', 'clinic-1'])),
    );
    d.setAuthTag(Buffer.from(tag!, 'base64url'));
    expect(() =>
      Buffer.concat([d.update(Buffer.from(ct!, 'base64url')), d.final()]),
    ).toThrow();
  });

  it('error messages carry no material, binding or secret', () => {
    const { env } = envelope();
    const sealed = env.seal(binding, MATERIAL);
    try {
      env.open({ ...binding, clinicId: 'clinic-2' }, sealed);
      throw new Error('expected failure');
    } catch (e) {
      const text = `${(e as Error).message}${(e as Error).stack}`;
      for (const secret of [MATERIAL, SECRET, 'entry-1', 'clinic-2']) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
