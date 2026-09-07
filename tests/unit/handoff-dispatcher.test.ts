import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  decideHandoff,
  assertAllowedTarget,
  dedupKey,
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
      workflowRun: { status: 'completed', conclusion: 'success', head_sha: 'abc123' },
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
        workflowRun: { status: 'completed', conclusion: 'success', head_sha: 'old-sha' },
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

  it('only surfaces MERGE_READY when exact-head CI is green', () => {
    expect(
      decideHandoff({
        eventName: 'issue_comment',
        pr: normalPr,
        commentBody: 'PASS / MERGE_READY',
        ciGreen: false,
      }),
    ).toBeNull();

    expect(
      decideHandoff({
        eventName: 'issue_comment',
        pr: normalPr,
        commentBody: 'PASS / MERGE_READY',
        ciGreen: true,
      }),
    ).toMatchObject({ kind: 'merge-ready-green', target: 'orchestrator' });
  });

  it('hard-blocks paused Gemini targets', () => {
    expect(() => assertAllowedTarget('gemini_chat')).toThrow(/Paused actor/);
    expect(() => assertAllowedTarget('gemini_agent')).toThrow(/Paused actor/);
    expect(() => assertAllowedTarget('claude')).not.toThrow();
  });

  it('uses deterministic dedup markers and recognizes Copilot identities', () => {
    expect(dedupKey('review', 'abc')).toBe('<!-- tabibi-handoff:review:abc -->');
    expect(isCopilotLogin('Copilot')).toBe(true);
    expect(isCopilotLogin('copilot-swe-agent[bot]')).toBe(true);
    expect(isCopilotLogin('NTinkicht')).toBe(false);
  });
});
