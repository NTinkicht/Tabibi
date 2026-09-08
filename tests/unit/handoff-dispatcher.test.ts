import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  decideHandoff,
  assertAllowedTarget,
  dedupKey,
  getPrNumber,
  isCopilotLogin,
  parseSpecialistReview,
  hasExplicitMergeReadySignal,
} = require('../../scripts/coordination/handoff-dispatcher.cjs') as {
  decideHandoff: (input: Record<string, unknown>) => {
    kind: string;
    target: string;
    sha: string;
    message: string;
  } | null;
  assertAllowedTarget: (target: string) => void;
  dedupKey: (kind: string, sha?: string) => string;
  getPrNumber: (
    eventName: string,
    payload: Record<string, unknown>,
  ) => number | null;
  isCopilotLogin: (login: string) => boolean;
  parseSpecialistReview: (text: string) => Record<string, string> | null;
  hasExplicitMergeReadySignal: (
    text: string,
    expectedSha?: string,
    expectedPrNumber?: number,
  ) => boolean;
};

const copilotPr = {
  number: 57,
  user: { login: 'copilot-swe-agent[bot]' },
  head: { sha: 'abc123' },
};

const normalPr = {
  number: 51,
  user: { login: 'NTinkicht' },
  head: { sha: 'def456' },
};

function specialistReviewBody(
  verdict: 'PASS' | 'PASS_WITH_MINOR_FINDINGS' = 'PASS',
  overrides: Record<string, string> = {},
) {
  return [
    'SPECIALIST_REVIEW',
    `actor: ${overrides.actor ?? 'codex'}`,
    `overlay: ${overrides.overlay ?? 'code-reviewer'}`,
    `pr: ${overrides.pr ?? '51'}`,
    `exact_sha: ${overrides.exact_sha ?? 'def456'}`,
    `verdict: ${overrides.verdict ?? verdict}`,
    `merge_ready: ${overrides.merge_ready ?? 'yes'}`,
    'findings:',
    verdict === 'PASS' ? '- NOTE: none' : '- MINOR: non-blocking follow-up',
  ].join('\n');
}

describe('event-driven handoff dispatcher', () => {
  it('routes a green Copilot-authored exact head to Claude without invoking paused Gemini', () => {
    const decision = decideHandoff({
      eventName: 'workflow_run',
      pr: copilotPr,
      workflowRun: {
        status: 'completed',
        conclusion: 'success',
        head_sha: 'abc123',
      },
    });

    expect(decision).toMatchObject({
      kind: 'copilot-ci-green-review',
      target: 'claude',
      sha: 'abc123',
    });
    expect(decision?.message).toContain('HANDOFF_TO_CLAUDE');
  });

  it('ignores stale workflow completion for an older PR head', () => {
    expect(
      decideHandoff({
        eventName: 'workflow_run',
        pr: copilotPr,
        workflowRun: {
          status: 'completed',
          conclusion: 'success',
          head_sha: 'old-sha',
        },
      }),
    ).toBeNull();
  });

  it('routes CHANGES_REQUIRED on Copilot work back to the same Copilot PR', () => {
    const decision = decideHandoff({
      eventName: 'pull_request_review',
      pr: copilotPr,
      review: { state: 'changes_requested', body: 'CHANGES_REQUIRED' },
    });

    expect(decision).toMatchObject({
      kind: 'changes-required-remediation',
      target: 'copilot',
    });
    expect(decision?.message).toContain('@copilot');
    expect(decision?.message).toContain('existing canonical branch');
  });

  it('never auto-promotes plain issue-comment CHANGES_REQUIRED claims', () => {
    expect(
      decideHandoff({
        eventName: 'issue_comment',
        pr: copilotPr,
        commentBody:
          'OPENROUTER_COUNCIL_ADVISORY\n\nVerdict: CHANGES_REQUIRED\nPASS_WITH_MINOR_FINDINGS',
      }),
    ).toBeNull();
  });

  it.each(['PASS', 'PASS_WITH_MINOR_FINDINGS'] as const)(
    'routes a canonical %s structured specialist review only when approval, eligibility, exact head, and green CI all match',
    (verdict) => {
      const body = specialistReviewBody(verdict);
      expect(
        decideHandoff({
          eventName: 'pull_request_review',
          pr: normalPr,
          review: {
            state: 'approved',
            body,
            commit_id: 'def456',
          },
          ciGreen: true,
          reviewerEligible: true,
        }),
      ).toMatchObject({ kind: 'merge-ready-green', target: 'orchestrator' });
    },
  );

  it('rejects stale exact_sha, wrong PR, merge_ready no, non-approved reviews, and ineligible reviewers', () => {
    const cases = [
      {
        body: specialistReviewBody('PASS', { exact_sha: 'old-sha' }),
        state: 'approved',
        eligible: true,
      },
      {
        body: specialistReviewBody('PASS', { pr: '99' }),
        state: 'approved',
        eligible: true,
      },
      {
        body: specialistReviewBody('PASS', { merge_ready: 'no' }),
        state: 'approved',
        eligible: true,
      },
      {
        body: specialistReviewBody('PASS'),
        state: 'commented',
        eligible: true,
      },
      {
        body: specialistReviewBody('PASS'),
        state: 'approved',
        eligible: false,
      },
    ];

    for (const testCase of cases) {
      expect(
        decideHandoff({
          eventName: 'pull_request_review',
          pr: normalPr,
          review: {
            state: testCase.state,
            body: testCase.body,
            commit_id: 'def456',
          },
          ciGreen: true,
          reviewerEligible: testCase.eligible,
        }),
      ).toBeNull();
    }
  });

  it('rejects prose, quoted text, and fenced examples containing PASS / MERGE_READY', () => {
    const bodies = [
      'Expected output is PASS / MERGE_READY',
      '> SPECIALIST_REVIEW\n> actor: codex\n> overlay: code-reviewer\n> pr: 51\n> exact_sha: def456\n> verdict: PASS\n> merge_ready: yes',
      '```text\nSPECIALIST_REVIEW\nactor: codex\noverlay: code-reviewer\npr: 51\nexact_sha: def456\nverdict: PASS\nmerge_ready: yes\n```',
    ];

    for (const body of bodies) {
      expect(hasExplicitMergeReadySignal(body, 'def456', 51)).toBe(false);
      expect(parseSpecialistReview(body)).toBeNull();
    }
  });

  it('requires a literal structured artifact at the start of the review body', () => {
    const body = specialistReviewBody('PASS');
    expect(parseSpecialistReview(body)).toMatchObject({
      actor: 'codex',
      overlay: 'code-reviewer',
      pr: '51',
      exact_sha: 'def456',
      verdict: 'PASS',
      merge_ready: 'yes',
    });
    expect(hasExplicitMergeReadySignal(body, 'def456', 51)).toBe(true);
  });

  it('never auto-promotes plain issue-comment MERGE_READY claims', () => {
    expect(
      decideHandoff({
        eventName: 'issue_comment',
        pr: normalPr,
        commentBody: 'PASS / MERGE_READY for def456',
        ciGreen: true,
        reviewerEligible: true,
      }),
    ).toBeNull();
  });

  it('hard-blocks paused Gemini targets', () => {
    expect(() => assertAllowedTarget('gemini_chat')).toThrow(/Paused actor/);
    expect(() => assertAllowedTarget('gemini_agent')).toThrow(/Paused actor/);
    expect(() => assertAllowedTarget('claude')).not.toThrow();
  });

  it('ignores normal Issue #21-style comments before any PR lookup or routing', () => {
    expect(
      getPrNumber('issue_comment', {
        issue: { number: 21 },
        comment: { body: 'HEARTBEAT' },
      }),
    ).toBeNull();

    expect(
      getPrNumber('issue_comment', {
        issue: {
          number: 65,
          pull_request: { url: 'https://example.test/pr/65' },
        },
        comment: { body: '@copilot review' },
      }),
    ).toBe(65);
  });

  it('uses deterministic dedup markers and recognizes Copilot identities', () => {
    expect(dedupKey('review', 'abc')).toBe(
      '<!-- tabibi-handoff:review:abc -->',
    );
    expect(isCopilotLogin('Copilot')).toBe(true);
    expect(isCopilotLogin('copilot-swe-agent[bot]')).toBe(true);
    expect(isCopilotLogin('NTinkicht')).toBe(false);
  });
});
