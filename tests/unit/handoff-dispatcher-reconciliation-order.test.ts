import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseSpecialistReview, reconcileGateEligibility } = require(
  '../../scripts/coordination/handoff-dispatcher.cjs',
) as {
  parseSpecialistReview: (text: string) => Record<string, unknown> | null;
  reconcileGateEligibility: (
    input: Record<string, unknown>,
  ) => Record<string, string> | null;
};

function specialistReviewBody() {
  return [
    'SPECIALIST_REVIEW',
    'actor: coderabbit',
    'overlay: code-reviewer',
    'pr: 112',
    'exact_sha: test-sha',
    'verdict: PASS',
    'merge_ready: yes',
    'findings:',
    '- NOTE: none',
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
      `pr: ${overrides.pr ?? '112'}`,
      `exact_sha: ${overrides.exact_sha ?? 'test-sha'}`,
      `gate_actor: ${overrides.gate_actor ?? 'coderabbit'}`,
      `reviewer_login: ${overrides.reviewer_login ?? 'coderabbitai'}`,
      `overlay: ${overrides.overlay ?? 'code-reviewer'}`,
      `material_authorship: ${overrides.material_authorship ?? 'independent'}`,
      `open_blockers: ${overrides.open_blockers ?? '0'}`,
      `open_majors: ${overrides.open_majors ?? '0'}`,
      `status: ${overrides.status ?? 'eligible'}`,
    ].join('\n'),
  };
}

describe('gate reconciliation ordering', () => {
  const common = {
    prNumber: 112,
    sha: 'test-sha',
    artifact: parseSpecialistReview(specialistReviewBody()),
    reviewLogin: 'coderabbitai',
  };

  it('rejects an older eligible record when a newer matching record revokes eligibility', () => {
    expect(
      reconcileGateEligibility({
        ...common,
        comments: [
          reconciliationComment(),
          reconciliationComment({ status: 'ineligible' }),
        ],
      }),
    ).toBeNull();
  });

  it('rejects an older eligible record when a newer matching record adds a major finding', () => {
    expect(
      reconcileGateEligibility({
        ...common,
        comments: [
          reconciliationComment(),
          reconciliationComment({ open_majors: '1' }),
        ],
      }),
    ).toBeNull();
  });

  it('accepts the newest matching record when it restores clean eligibility', () => {
    expect(
      reconcileGateEligibility({
        ...common,
        comments: [
          reconciliationComment({ status: 'ineligible' }),
          reconciliationComment(),
        ],
      }),
    ).toMatchObject({ status: 'eligible', open_blockers: '0', open_majors: '0' });
  });
});
