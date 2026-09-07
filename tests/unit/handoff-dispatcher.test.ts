import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  decideHandoff,
  assertAllowedTarget,
  dedupKey,
  getPrNumber,
  isCopilotLogin,
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

  it('only surfaces review MERGE_READY for the live exact head with green CI', () => {
    expect(
      decideHandoff({
        eventName: 'pull_request_review',
        pr: normalPr,
        review: {
          state: 'approved',
          body: 'PASS / MERGE_READY',
          commit_id: 'old-sha',
        },
        ciGreen: true,
      }),
    ).toBeNull();

    expect(
      decideHandoff({
        eventName: 'pull_request_review',
        pr: normalPr,
        review: {
          state: 'approved',
          body: 'PASS / MERGE_READY',
          commit_id: 'def456',
        },
        ciGreen: false,
      }),
    ).toBeNull();

    expect(
      decideHandoff({
        eventName: 'pull_request_review',
        pr: normalPr,
        review: {
          state: 'approved',
          body: 'PASS / MERGE_READY',
          commit_id: 'def456',
        },
        ciGreen: true,
      }),
    ).toMatchObject({ kind: 'merge-ready-green', target: 'orchestrator' });
  });

  it('never auto-promotes plain issue-comment MERGE_READY claims', () => {
    expect(
      decideHandoff({
        eventName: 'issue_comment',
        pr: normalPr,
        commentBody: 'PASS / MERGE_READY for def456',
        ciGreen: true,
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
