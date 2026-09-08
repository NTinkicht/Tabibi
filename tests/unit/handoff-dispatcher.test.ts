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
  parseGateReconciliation,
  reconcileGateEligibility,
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
  parseSpecialistReview: (text: string) =>
    | (Record<string, string> & {
        findings: Array<{ severity: string; text: string }>;
      })
    | null;
  parseGateReconciliation: (text: string) => Record<string, string> | null;
  reconcileGateEligibility: (input: Record<string, unknown>) =>
    | Record<string, string>
    | null;
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
  findings = verdict === 'PASS'
    ? ['- NOTE: none']
    : ['- MINOR: non-blocking follow-up'],
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
    ...findings,
  ].join('\n');
}

function reconciliationComment(
  overrides: Record<string, string> = {},
  authorAssociation = 'OWNER',
) {
  return {
    author_association: authorAssociation,
    body: [
      'GATE_RECONCILIATION',
      `pr: ${overrides.pr ?? '51'}`,
      `exact_sha: ${overrides.exact_sha ?? 'def456'}`,
      `gate_actor: ${overrides.gate_actor ?? 'codex'}`,
      `reviewer_login: ${overrides.reviewer_login ?? 'chatgpt-codex-connector'}`,
      `overlay: ${overrides.overlay ?? 'code-reviewer'}`,
      `material_authorship: ${overrides.material_authorship ?? 'independent'}`,
      `open_blockers: ${overrides.open_blockers ?? '0'}`,
      `open_majors: ${overrides.open_majors ?? '0'}`,
      `status: ${overrides.status ?? 'eligible'}`,
    ].join('\n'),
  };
}

function trustedGateReconciliation() {
  const artifact = parseSpecialistReview(specialistReviewBody());
  return reconcileGateEligibility({
    comments: [reconciliationComment()],
    prNumber: 51,
    sha: 'def456',
    artifact,
    reviewLogin: 'chatgpt-codex-connector',
  });
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
    'routes canonical %s only with trusted exact-head reconciliation and green CI',
    (verdict) => {
      const body = specialistReviewBody(verdict);
      const artifact = parseSpecialistReview(body);
      const gateReconciliation = reconcileGateEligibility({
        comments: [reconciliationComment()],
        prNumber: 51,
        sha: 'def456',
        artifact,
        reviewLogin: 'chatgpt-codex-connector',
      });

      expect(gateReconciliation).not.toBeNull();
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
          gateReconciliation,
        }),
      ).toMatchObject({ kind: 'merge-ready-green', target: 'orchestrator' });
    },
  );

  it('rejects stale SHA, wrong PR, merge_ready no, non-approved review, or missing reconciliation', () => {
    const cases = [
      specialistReviewBody('PASS', { exact_sha: 'old-sha' }),
      specialistReviewBody('PASS', { pr: '99' }),
      specialistReviewBody('PASS', { merge_ready: 'no' }),
    ];

    for (const body of cases) {
      expect(
        decideHandoff({
          eventName: 'pull_request_review',
          pr: normalPr,
          review: { state: 'approved', body, commit_id: 'def456' },
          ciGreen: true,
          gateReconciliation: trustedGateReconciliation(),
        }),
      ).toBeNull();
    }

    expect(
      decideHandoff({
        eventName: 'pull_request_review',
        pr: normalPr,
        review: {
          state: 'commented',
          body: specialistReviewBody(),
          commit_id: 'def456',
        },
        ciGreen: true,
        gateReconciliation: trustedGateReconciliation(),
      }),
    ).toBeNull();

    expect(
      decideHandoff({
        eventName: 'pull_request_review',
        pr: normalPr,
        review: {
          state: 'approved',
          body: specialistReviewBody(),
          commit_id: 'def456',
        },
        ciGreen: true,
        gateReconciliation: null,
      }),
    ).toBeNull();
  });

  it('rejects every non-code-reviewer overlay as a binding merge gate', () => {
    for (const overlay of [
      'persona-walkthrough',
      'database-reliability',
      'sre',
      'backend-architect',
    ]) {
      const body = specialistReviewBody('PASS', { overlay });
      expect(hasExplicitMergeReadySignal(body, 'def456', 51)).toBe(false);
    }
  });

  it('rejects prose, quoted text, fenced examples, and prose inside SPECIALIST_REVIEW', () => {
    const bodies = [
      'Expected output is PASS / MERGE_READY',
      '> SPECIALIST_REVIEW\n> actor: codex\n> overlay: code-reviewer\n> pr: 51\n> exact_sha: def456\n> verdict: PASS\n> merge_ready: yes',
      '```text\nSPECIALIST_REVIEW\nactor: codex\noverlay: code-reviewer\npr: 51\nexact_sha: def456\nverdict: PASS\nmerge_ready: yes\n```',
      [
        'SPECIALIST_REVIEW',
        'This is only an example; do not merge:',
        'actor: codex',
        'overlay: code-reviewer',
        'pr: 51',
        'exact_sha: def456',
        'verdict: PASS',
        'merge_ready: yes',
        'findings:',
        '- NOTE: none',
      ].join('\n'),
    ];

    for (const body of bodies) {
      expect(hasExplicitMergeReadySignal(body, 'def456', 51)).toBe(false);
      expect(parseSpecialistReview(body)).toBeNull();
    }
  });

  it('rejects passing artifacts containing BLOCKER or MAJOR findings', () => {
    for (const severity of ['BLOCKER', 'MAJOR']) {
      const body = specialistReviewBody('PASS', {}, [
        `- ${severity}: unresolved defect`,
      ]);
      expect(hasExplicitMergeReadySignal(body, 'def456', 51)).toBe(false);
    }
  });

  it('accepts trusted reconciliation only from authorized associations with zero blocking findings', () => {
    const artifact = parseSpecialistReview(specialistReviewBody());
    const common = {
      prNumber: 51,
      sha: 'def456',
      artifact,
      reviewLogin: 'chatgpt-codex-connector',
    };

    expect(
      reconcileGateEligibility({
        ...common,
        comments: [reconciliationComment()],
      }),
    ).toMatchObject({ status: 'eligible', material_authorship: 'independent' });

    expect(
      reconcileGateEligibility({
        ...common,
        comments: [reconciliationComment({}, 'NONE')],
      }),
    ).toBeNull();
    expect(
      reconcileGateEligibility({
        ...common,
        comments: [
          reconciliationComment({ material_authorship: 'material_author' }),
        ],
      }),
    ).toBeNull();
    expect(
      reconcileGateEligibility({
        ...common,
        comments: [reconciliationComment({ open_majors: '1' })],
      }),
    ).toBeNull();
    expect(
      reconcileGateEligibility({
        ...common,
        comments: [reconciliationComment({ open_blockers: '1' })],
      }),
    ).toBeNull();
  });

  it('requires the trusted reconciliation to match the leased actor, reviewer login, overlay, PR, and SHA', () => {
    const artifact = parseSpecialistReview(specialistReviewBody());
    const common = {
      prNumber: 51,
      sha: 'def456',
      artifact,
      reviewLogin: 'chatgpt-codex-connector',
    };

    for (const overrides of [
      { gate_actor: 'claude' },
      { reviewer_login: 'someone-else' },
      { overlay: 'persona-walkthrough' },
      { pr: '99' },
      { exact_sha: 'old-sha' },
      { status: 'ineligible' },
    ]) {
      expect(
        reconcileGateEligibility({
          ...common,
          comments: [reconciliationComment(overrides)],
        }),
      ).toBeNull();
    }
  });

  it('parses only the canonical gate reconciliation schema', () => {
    expect(parseGateReconciliation(reconciliationComment().body)).toMatchObject({
      gate_actor: 'codex',
      reviewer_login: 'chatgpt-codex-connector',
      overlay: 'code-reviewer',
      status: 'eligible',
    });
    expect(
      parseGateReconciliation(
        `${reconciliationComment().body}\nThis prose is not allowed`,
      ),
    ).toBeNull();
  });

  it('never auto-promotes plain issue-comment MERGE_READY claims', () => {
    expect(
      decideHandoff({
        eventName: 'issue_comment',
        pr: normalPr,
        commentBody: 'PASS / MERGE_READY for def456',
        ciGreen: true,
        gateReconciliation: trustedGateReconciliation(),
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
