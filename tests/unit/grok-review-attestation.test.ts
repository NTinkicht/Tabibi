import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// The trusted Grok worker deliberately uses dependency-free Node ESM.
// @ts-expect-error Runtime .mjs has no separately generated declaration.
import * as attest from '../../scripts/coordination/grok-review-attestation.mjs';

const sha = 'a'.repeat(40);
const lease = {
  key: 'b'.repeat(64),
  pr: 496,
  sha,
  commentId: 411,
  authors: ['chatgpt'],
};
const answer = {
  stopReason: 'end_turn',
  sessionId: '01a0d894-175e-79c3-bee6-c04cf34db2d0',
  requestId: '200aba73-3374-4c84-9629-bf7d8a73cfa7',
  text: `SHA ${sha}\nVERDICT: PASS`,
};

describe('Grok Codespace independent review signature', () => {
  it('pins a private local signing key to a reviewed public key', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabibi-grok-key-'));
    const file = path.join(home, 'review-signing-key.pem');
    const registry = path.join(home, 'public-keys.json');
    const pair = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicPem = pair.publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    try {
      fs.writeFileSync(file, pem, { mode: 0o600 });
      fs.writeFileSync(
        registry,
        JSON.stringify({
          version: 1,
          keys: [{
            id: attest.SIGNER_ID,
            public_key_pem: publicPem,
          }],
        }),
      );
      const signer = attest.loadSigner(home, registry);
      const body = attest.buildAttestedReview(lease, answer, signer);
      const match = body.match(
        /<!-- tabibi-grok-attestation-v1:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+) -->$/,
      );
      expect(match).not.toBeNull();
      const payload = Buffer.from(match![1], 'base64url');
      const signature = Buffer.from(match![2], 'base64url');
      const proof = JSON.parse(payload.toString('utf8'));
      const visible = body.slice(0, body.lastIndexOf('\n\n<!--'));
      expect(proof).toMatchObject({
        actor: 'grok',
        pr: 496,
        exact_sha: sha,
        lease_comment_id: 411,
        verdict: 'PASS',
        provider_request_id: answer.requestId,
        provider_session_id: answer.sessionId,
      });
      expect(proof.review_body_sha256).toBe(
        createHash('sha256').update(visible).digest('hex'),
      );
      expect(
        verify(null, payload, createPublicKey(publicPem), signature),
      ).toBe(true);
      expect(
        verify(null, payload, other.publicKey, signature),
      ).toBe(false);
      expect(
        verify(
          null,
          Buffer.from(payload.toString() + 'tampered'),
          pair.publicKey,
          signature,
        ),
      ).toBe(false);
      expect(() =>
        attest.buildAttestedReview(
          lease,
          { ...answer, stopReason: 'max_turns' },
          signer,
        ),
      ).toThrow('grok_attestation_invalid');
      expect(() =>
        attest.buildAttestedReview(
          lease,
          { ...answer, text: `SHA ${sha}\nPASS (not a formal verdict)` },
          signer,
        ),
      ).toThrow('grok_attestation_invalid');
      fs.chmodSync(file, 0o644);
      expect(() => attest.loadSigner(home, registry)).toThrow(
        'grok_signer_unavailable',
      );
      fs.chmodSync(file, 0o600);
      fs.writeFileSync(registry, JSON.stringify({ version: 1, keys: [] }));
      expect(() => attest.loadSigner(home, registry)).toThrow(
        'grok_signer_unavailable',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
