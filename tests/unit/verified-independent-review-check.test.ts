import fs from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const yaml = createRequire(import.meta.url)('js-yaml') as {
  load: (value: string) => unknown;
};

const source = fs.readFileSync(
  '.github/workflows/verified-independent-review.yml',
  'utf8',
);
const script = fs.readFileSync(
  'scripts/coordination/publish-independent-review-check.py',
  'utf8',
);

const workflow = yaml.load(source) as {
  on: {
    pull_request: { types: string[] };
    pull_request_review: { types: string[] };
    issue_comment: { types: string[] };
    workflow_run: { workflows: string[]; types: string[] };
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
  permissions: Record<string, string>;
  jobs: {
    verify: {
      steps: Array<{
        name?: string;
        uses?: string;
        with?: Record<string, string | boolean>;
        env?: Record<string, string>;
        run?: string;
      }>;
    };
  };
};

describe('trusted independent review check publisher', () => {
  it('runs from trusted main, not PR-controlled verifier code', () => {
    expect(workflow.permissions.checks).toBe('write');
    expect(workflow.permissions.contents).toBe('read');
    expect(workflow.permissions['pull-requests']).toBe('read');
    const steps = workflow.jobs.verify.steps;
    const checkout = steps.find((step) => step.uses?.includes('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('main');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    expect(steps.some((step) => step.with?.ref?.toString().includes('head.sha'))).toBe(false);
    expect(source).not.toContain('MISTRAL_API_KEY');
    expect(source).not.toContain('XAI_API_KEY');
  });

  it('rechecks changing PRs, review verdicts and completed provider evidence', () => {
    expect(workflow.on.pull_request.types).toContain('synchronize');
    expect(workflow.on.pull_request_review.types).toContain('submitted');
    expect(workflow.on.pull_request_review.types).toContain('dismissed');
    expect(workflow.on.issue_comment.types).toContain('created');
    expect(workflow.on.workflow_run.workflows).toContain('CI');
    expect(workflow.on.workflow_run.workflows).toContain('Mistral Vibe Wake');
    expect(workflow.on.workflow_dispatch.inputs).toHaveProperty('pr_number');
  });

  it('fails closed with a SHA-attached check, not a green workflow on main', () => {
    expect(script).toContain('independent-review-gate.py');
    expect(script).toContain('module.evaluate(number) != sha');
    expect(script).toContain('native_review_holds(number)');
    expect(script).toContain('no_open_threads(number)');
    expect(script).toContain('CHECK_NAME = "Independent AI review / Verified final head"');
    expect(script).toContain('"head_sha": sha');
    expect(script).toContain('"conclusion": "success" if passed else "failure"');
    expect(script).not.toContain('gh pr merge');
    expect(script).not.toContain('XAI_API_KEY');
  });
});
