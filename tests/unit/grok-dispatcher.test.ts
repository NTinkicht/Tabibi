import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

// The dispatcher is intentionally plain Node ESM; no npm install needed for runtime.
// @ts-expect-error The runtime .mjs file intentionally has no generated types.
import {
  MARKER,
  parseLease,
  pendingLeases,
  reviewPrompt,
} from '../../scripts/grok-dispatcher.mjs';

const sha = 'a'.repeat(40);
const comment = (
  body: string,
  id = 100,
  association = 'OWNER',
  login = 'NTinkicht',
) => ({
  body,
  id,
  author_association: association,
  user: { login },
});
const pr = (head = sha, number = 456, state = 'open', draft = false) => ({
  number,
  state,
  draft,
  head: { sha: head },
});
const valid = [
  MARKER,
  'actor: grok',
  'capability: review',
  'pr: #456',
  `exact_sha: ${sha}`,
  'material_authors: codex,claude',
].join('\n');

describe('owner-private Grok dispatch lease parser', () => {
  it('parses exact-head explicitly leased independent review', () => {
    const result = parseLease(valid, comment(valid), pr());
    expect(result).toMatchObject({
      pr: 456,
      sha,
      commentId: 100,
      authors: ['codex', 'claude'],
    });
    expect(result.key).toBe(
      createHash('sha256')
        .update(`456:${sha}:100:review`)
        .digest('hex'),
    );
  });

  it('rejects vague mentions and unleased tasks', () => {
    expect(parseLease('@grok review this', comment('@grok review this'), pr())).toBeNull();
    expect(parseLease('CI_GREEN_HANDOFF', comment('CI_GREEN_HANDOFF'), pr())).toBeNull();
  });

  it('rejects stale SHA, wrong PR, drafts, and closed PRs', () => {
    expect(parseLease(valid, comment(valid), pr('b'.repeat(40)))).toBeNull();
    expect(parseLease(valid, comment(valid), pr(sha, 123))).toBeNull();
    expect(parseLease(valid, comment(valid), pr(sha, 456, 'closed'))).toBeNull();
    expect(parseLease(valid, comment(valid), pr(sha, 456, 'open', true))).toBeNull();
  });

  it('rejects self-gating and missing explicit material authors', () => {
    const self = valid.replace('codex,claude', 'grok,claude');
    expect(parseLease(self, comment(self), pr())).toBeNull();
    const missing = valid.replace('material_authors: codex,claude', '');
    expect(parseLease(missing, comment(missing), pr())).toBeNull();
  });

  it('rejects untrusted commenter and unexpected role/capability', () => {
    expect(parseLease(valid, comment(valid, 1, 'NONE'), pr())).toBeNull();
    expect(parseLease(valid, comment(valid, 1, 'OWNER', 'stranger'), pr())).toBeNull();
    const implementation = valid.replace('capability: review', 'capability: implementation');
    expect(parseLease(implementation, comment(implementation), pr())).toBeNull();
  });

  it('rejects duplicate/unknown fields, ambiguous authors and invalid hashes', () => {
    const duplicate = `${valid}\nactor: grok`;
    expect(parseLease(duplicate, comment(duplicate), pr())).toBeNull();
    const unknown = `${valid}\nbilling: true`;
    expect(parseLease(unknown, comment(unknown), pr())).toBeNull();
    const dupAuthors = valid.replace('codex,claude', 'codex,codex');
    expect(parseLease(dupAuthors, comment(dupAuthors), pr())).toBeNull();
    const shortSha = valid.replace(sha, 'aaa');
    expect(parseLease(shortSha, comment(shortSha), pr())).toBeNull();
  });

  it('deduplicates completed leases and orders eligible work by comment ID', () => {
    const old = comment(valid, 42);
    const newOne = comment(valid, 43);
    const done = new Set([parseLease(valid, old, pr()).key]);
    expect(pendingLeases([pr()], { 456: [newOne, old] }, done)).toMatchObject([
      { commentId: 43 },
    ]);
  });

  it('prompts Grok to stay read-only and not self-assert merge readiness with red CI', () => {
    const lease = parseLease(valid, comment(valid), pr());
    const prompt = reviewPrompt(lease, [
      { name: 'Quality and build', conclusion: 'failure' },
    ]);
    expect(prompt).toContain(sha);
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('never say MERGE_READY');
    expect(prompt).toContain('DO NOT EDIT, COMMIT, PUSH, MERGE');
  });
});
