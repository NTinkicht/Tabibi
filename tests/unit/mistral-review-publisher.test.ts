import fs from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const yaml = createRequire(import.meta.url)('js-yaml') as {
  load: (value: string) => unknown;
};

type WorkflowJob = {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  steps: Array<{
    name?: string;
    uses?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
    run?: string;
  }>;
};

const workflow = yaml.load(
  fs.readFileSync('.github/workflows/mistral-vibe-wake.yml', 'utf8'),
) as {
  permissions: Record<string, string>;
  jobs: {
    'mistral-vibe': WorkflowJob;
    'publish-review': WorkflowJob;
  };
};

describe('Mistral PR publisher privilege isolation', () => {
  it('keeps PR-write permission out of the model invocation', () => {
    const model = workflow.jobs['mistral-vibe'];
    const publisher = workflow.jobs['publish-review'];
    expect(workflow.permissions['pull-requests']).toBe('read');
    expect(model.permissions?.['pull-requests']).toBeUndefined();
    expect(publisher.permissions?.['pull-requests']).toBe('write');
    expect(publisher.permissions?.issues).toBe('write');
    expect(publisher.permissions?.contents).toBe('read');
    expect(publisher.needs).toBe('mistral-vibe');
    expect(publisher.if).toContain("needs.mistral-vibe.result == 'success'");
    expect(publisher.if).toContain("github.actor == 'NTinkicht'");
    expect(publisher.if).toContain('BINDING_EXACT_HEAD_REVIEW');
  });

  it('uses trusted main without model keys or PR checkout', () => {
    const model = workflow.jobs['mistral-vibe'];
    const publisher = workflow.jobs['publish-review'];
    const report = model.steps.find(
      (step) => step.name === 'Post Mistral result',
    );
    expect(report?.run).toContain('gh issue comment 11');
    expect(report?.run).not.toContain('gh issue comment "$REVIEW_PR"');
    const checkout = publisher.steps.find((step) =>
      step.uses?.includes('checkout'),
    );
    expect(checkout?.with?.ref).toBe('main');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    const publish = publisher.steps.find((step) =>
      step.run?.includes('publish-mistral-review.py'),
    );
    expect(publish?.env?.GH_TOKEN).toContain('secrets.GITHUB_TOKEN');
    expect(
      publisher.steps.some((step) => step.env?.MISTRAL_API_KEY),
    ).toBe(false);
    expect(
      publisher.steps.some(
        (step) =>
          (step.run ?? '').includes('vibe ') ||
          (step.run ?? '').includes('npm ') ||
          (step.run ?? '').includes('gh pr merge'),
      ),
    ).toBe(false);
  });
});
