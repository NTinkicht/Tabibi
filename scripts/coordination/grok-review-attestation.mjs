#!/usr/bin/env node
// Trusted owner-Codespace Grok Build receipt. Private key NEVER leaves ~/.grok.
// An owner-account GitHub comment alone is not evidence that Grok executed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNER_ID = 'owner-codespace-v1';
export const MARKER = 'tabibi-grok-attestation-v1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_REGISTRY = path.join(ROOT, 'coordination/trust/grok-review-public-keys.json');
const SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

export function loadSigner(
  grokHome = path.join(os.homedir(), '.grok'),
  registryPath = DEFAULT_REGISTRY,
) {
  // Fail before invoking Grok if the local signer cannot be verified against
  // the reviewed public trust root on trusted main.
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (
    registry.version !== 1 ||
    !Array.isArray(registry.keys) ||
    registry.keys.length > 8
  ) throw new Error('grok_signer_unavailable');
  const pinned = registry.keys.filter((entry) => entry.id === SIGNER_ID);
  if (pinned.length !== 1) throw new Error('grok_signer_unavailable');
  const filename = path.join(grokHome, 'review-signing-key.pem');
  // Grok's built-in strict sandbox can READ all ~/.grok! Never let the model
  // see the signer, even via Bash/symlink. Require an owner-global custom
  // strict profile with a kernel-enforced read/write deny on this exact file.
  const sandbox = fs.readFileSync(path.join(grokHome, 'sandbox.toml'), 'utf8');
  const section = sandbox
    .split('[profiles.tabibi_signed_review]')[1]
    ?.split('\\n[')[0];
  const lines = section?.split('\\n').map((line) => line.trim()) || [];
  if (
    !lines.includes('extends = "strict"') ||
    !lines.includes(`deny = ["${filename}"]`)
  ) throw new Error('grok_signer_unavailable');
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('grok_signer_unavailable');
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(filename, 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('grok_signer_unavailable');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const pinnedKey = crypto.createPublicKey(pinned[0].public_key_pem);
  const canonical = (key) => key.export({ type: 'spki', format: 'der' });
  if (!canonical(publicKey).equals(canonical(pinnedKey))) {
    throw new Error('grok_signer_unavailable');
  }
  return { id: SIGNER_ID, privateKey };
}

export function signAttestedReview(lease, answer, visible, signer, at = new Date()) {
  if (
    !Number.isSafeInteger(lease.pr) || lease.pr <= 0 ||
    !Number.isSafeInteger(lease.commentId) || lease.commentId <= 0 ||
    !SHA.test(lease.sha) ||
    !Array.isArray(lease.authors) || !lease.authors.length ||
    lease.authors.includes('grok') ||
    answer?.stopReason !== 'end_turn' ||
    typeof answer.text !== 'string' ||
    !answer.text.includes(lease.sha) ||
    typeof answer.requestId !== 'string' ||
    !/^[a-zA-Z0-9-]{8,128}$/.test(answer.requestId) ||
    typeof answer.sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]{8,128}$/.test(answer.sessionId) ||
    !signer?.privateKey || signer.id !== SIGNER_ID ||
    typeof visible !== 'string' || visible.length > 22000 ||
    !visible.includes(`source_lease_comment: ${lease.commentId}`) ||
    !visible.includes(`exact_sha: ${lease.sha}`)
  ) throw new Error('grok_attestation_invalid');
  const verdicts = [...answer.text.matchAll(/^VERDICT:[ \t]*(PASS|PASS_WITH_MINOR_FINDINGS|CHANGES_REQUIRED)[ \t]*$/gm)];
  if (verdicts.length !== 1) throw new Error('grok_attestation_invalid');
  const issuedAt = at.toISOString();
  const payload = {
    version: 1,
    actor: 'grok',
    runtime: 'owner-codespace-grok-build',
    key_id: signer.id,
    pr: lease.pr,
    exact_sha: lease.sha,
    lease_comment_id: lease.commentId,
    material_authors: [...lease.authors].sort(),
    verdict: verdicts[0][1],
    provider_request_id: answer.requestId,
    provider_session_id: answer.sessionId,
    stop_reason: answer.stopReason,
    review_body_sha256: crypto.createHash('sha256').update(visible, 'utf8').digest('hex'),
    issued_at: issuedAt,
  };
  if (!HEX_SHA256.test(payload.review_body_sha256) || !SAFE_ID.test(payload.key_id)) {
    throw new Error('grok_attestation_invalid');
  }
  const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign(null, canonical, signer.privateKey);
  return (
    visible + '\n\n<!-- ' + MARKER + ':' +
    canonical.toString('base64url') + ':' +
    signature.toString('base64url') + ' -->'
  );
}

export function buildAttestedReview(lease, answer, signer) {
  const visible =
    `<!-- tabibi-grok-dispatch:${lease.key} -->\n` +
    '**Automatic Grok Build review**\n\n' +
    `actor: grok\ncapability: review\nexact_sha: ${lease.sha}\n` +
    `source_lease_comment: ${lease.commentId}\n` +
    'runtime: owner-authenticated Codespace, included SuperGrok\n\n' +
    answer.text;
  return signAttestedReview(lease, answer, visible, signer);
}
