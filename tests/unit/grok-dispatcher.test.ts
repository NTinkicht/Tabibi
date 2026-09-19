import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

// The dispatcher is intentionally plain Node ESM; no npm install needed for runtime.
// @ts-expect-error The runtime .mjs file intentionally has no generated types.
import * as dispatcher from '../../scripts/grok-dispatcher.mjs';

const { MARKER, parseLease, pendingLeases, reviewPrompt } = dispatcher;

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
      createHash('sha256').update(`456:${sha}:100:review`).digest('hex'),
    );
  });

  it('rejects vague mentions and unleased tasks', () => {
    expect(
      parseLease('@grok review this', comment('@grok review this'), pr()),
    ).toBeNull();
    expect(
      parseLease('CI_GREEN_HANDOFF', comment('CI_GREEN_HANDOFF'), pr()),
    ).toBeNull();
  });

  it('rejects stale SHA, wrong PR, drafts, and closed PRs', () => {
    expect(parseLease(valid, comment(valid), pr('b'.repeat(40)))).toBeNull();
    expect(parseLease(valid, comment(valid), pr(sha, 123))).toBeNull();
    expect(
      parseLease(valid, comment(valid), pr(sha, 456, 'closed')),
    ).toBeNull();
    expect(
      parseLease(valid, comment(valid), pr(sha, 456, 'open', true)),
    ).toBeNull();
  });

  it('rejects self-gating and missing explicit material authors', () => {
    const self = valid.replace('codex,claude', 'grok,claude');
    expect(parseLease(self, comment(self), pr())).toBeNull();
    const missing = valid.replace('material_authors: codex,claude', '');
    expect(parseLease(missing, comment(missing), pr())).toBeNull();
  });

  it('rejects untrusted commenter and unexpected role/capability', () => {
    expect(parseLease(valid, comment(valid, 1, 'NONE'), pr())).toBeNull();
    expect(
      parseLease(valid, comment(valid, 1, 'OWNER', 'stranger'), pr()),
    ).toBeNull();
    const implementation = valid.replace(
      'capability: review',
      'capability: implementation',
    );
    expect(
      parseLease(implementation, comment(implementation), pr()),
    ).toBeNull();
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


describe('Grok dispatcher security and durability regression guards', () => {
  const lease = parseLease(valid, comment(valid), pr());

  it('isolates GitHub CLI and git credential paths without copying OAuth', () => {
    const env = dispatcher.grokReviewEnvironment(
      {
        HOME: '/home/codespace',
        GITHUB_TOKEN: 'should-not-inherit',
        GH_TOKEN: 'should-not-inherit',
        GH_HOST: 'github.com',
        GIT_ASKPASS: 'credential-helper',
        GIT_CONFIG_KEY_0: 'credential.helper',
        SSH_AUTH_SOCK: '/tmp/ssh.sock',
        PATH: '/usr/bin',
      },
      '/home/codespace/.grok',
      '/tmp/empty-grok-child-home',
    );
    expect(env.HOME).toBe('/tmp/empty-grok-child-home');
    expect(env.GROK_HOME).toBe('/home/codespace/.grok');
    expect(env.GH_CONFIG_DIR).toBe('/tmp/empty-grok-child-home/gh');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/empty-grok-child-home');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.PATH).toBe('/usr/bin');
    for (const key of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GH_HOST',
      'GIT_ASKPASS',
      'GIT_CONFIG_KEY_0',
      'SSH_AUTH_SOCK',
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('rejects known GitHub/API tokens, OAuth values and private keys in review text', () => {
    const assertSafe = dispatcher.assertSafeReviewOutput;
    const oauth = JSON.stringify({
      credentials: { access_token: 'custom-oauth-secret-value-123456' },
    });
    expect(assertSafe('PASS: no secrets; SHA ' + sha, oauth)).toContain(sha);
    const rejected = [
      'github_pat_' + 'a'.repeat(30),
      'ghp_' + 'A'.repeat(36),
      'Bearer a-really-long-token-1234567',
      'sk-' + 'A'.repeat(24),
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'custom-oauth-secret-value-123456',
      'access_token: anothersecretvalue12345',
    ];
    for (const value of rejected) {
      expect(() => assertSafe(value, oauth)).toThrow('unsafe_review_output');
    }
    expect(() => assertSafe('PASS', '{invalid JSON')).toThrow(
      'oauth_not_verified',
    );
  });

  it('requires complete review history and rejects Grok-authored commits', () => {
    const commits = [
      { commit: { message: 'Implement feature' } },
      { commit: { message: 'Fix tests' } },
    ];
    expect(dispatcher.isReviewAuthorEligible({ commits: 2 }, commits)).toBe(
      true,
    );
    expect(dispatcher.isReviewAuthorEligible({ commits: 3 }, commits)).toBe(
      false,
    );
    expect(
      dispatcher.isReviewAuthorEligible(
        { commits: 2 },
        [commits[0], { commit: { message: 'actor: grok updated tests' } }],
      ),
    ).toBe(false);
    expect(
      dispatcher.isReviewAuthorEligible(
        { commits: 101 },
        Array(101).fill(commits[0]),
      ),
    ).toBe(false);
  });

  it('cannot let an untrusted PR commenter forge proof of delivery', () => {
    const body = [
      '<!-- tabibi-grok-dispatch:' + lease.key + ' -->',
      'exact_sha: ' + lease.sha,
      'source_lease_comment: ' + lease.commentId,
    ].join('\n');
    expect(
      dispatcher.isTrustedDeliveryComment(lease, {
        user: { login: 'stranger' },
        body,
      }),
    ).toBe(false);
    expect(
      dispatcher.isTrustedDeliveryComment(lease, {
        user: { login: 'NTinkicht' },
        body: body.replace(lease.sha, 'b'.repeat(40)),
      }),
    ).toBe(false);
    expect(
      dispatcher.isTrustedDeliveryComment(lease, {
        user: { login: 'NTinkicht' },
        body,
      }),
    ).toBe(true);
  });

  it('deduplicates from old pages even after 200 later PR comments', () => {
    const body = [
      '<!-- tabibi-grok-dispatch:' + lease.key + ' -->',
      'exact_sha: ' + lease.sha,
      'source_lease_comment: ' + lease.commentId,
    ].join('\n');
    const seen: number[] = [];
    const api = (route: string) => {
      if (route.endsWith('/issues/' + lease.pr)) return { comments: 230 };
      const page = Number(route.match(/page=(\d+)$/)?.[1]);
      seen.push(page);
      return page === 1
        ? [{ user: { login: 'NTinkicht' }, body }]
        : [{ user: { login: 'stranger' }, body }];
    };
    expect(dispatcher.trustedPosted(lease, api)).toBe(true);
    expect(seen).toEqual([3, 2, 1]);
  });

  it('persists pending delivery before a failed write and retries without double-posting', () => {
    const outcomes: string[] = [];
    const persist = (_lease: unknown, outcome: string) => outcomes.push(outcome);
    const errorWrite = () => {
      throw new Error('GitHub unavailable');
    };
    expect(() =>
      dispatcher.deliver(lease, 'review report', 'REVIEW_POSTED', {
        persist,
        isPosted: () => false,
        write: errorWrite,
      }),
    ).toThrow('GitHub unavailable');
    expect(outcomes).toEqual(['DELIVERY_PENDING']);
    dispatcher.deliver(lease, 'review report', 'REVIEW_POSTED', {
      persist,
      isPosted: () => true,
      write: errorWrite,
    });
    expect(outcomes).toEqual([
      'DELIVERY_PENDING',
      'DELIVERY_PENDING',
      'REVIEW_POSTED',
    ]);
  });

  it('records a stale lease without falsely requesting actor failover', () => {
    expect(dispatcher.outcomeNotice('STALE_HEAD')).toBe(
      'STALE_LEASE_DISCARDED',
    );
    expect(dispatcher.outcomeNotice('STALE_HEAD_AFTER_REVIEW')).toBe(
      'STALE_LEASE_DISCARDED',
    );
    expect(dispatcher.outcomeNotice('SELF_AUTHORSHIP_BLOCKED')).toBe(
      'ROLE_FAILOVER_REQUIRED',
    );
  });
});
