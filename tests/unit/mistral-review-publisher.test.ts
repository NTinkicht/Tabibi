import fs from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const yaml = createRequire(import.meta.url)('js-yaml') as {
  load: (value: string) => unknown;
};

type Step = {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
};

type Job = {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
};

const text = fs.readFileSync('.github/workflows/mistral-vibe-wake.yml', 'utf8');
const workflow = yaml.load(text) as {
  permissions: Record<string, string>;
  jobs: {
    'mistral-vibe': Job;
    'publish-review': Job;
  };
};

describe('Mistral review publisher isolation', () => {
  it('keeps PR write access out of model execution', () => {
    const model = workflow.jobs['mistral-vibe'];
    const out = workflow.jobs['publish-review'];
    expect(workflow.permissions['pull-requests']).toBe('read');
    expect(model.permissions?.['pull-requests']).toBeUndefined();
    expect(out.permissions?.['pull-requests']).toBe('write');
    expect(out.permissions?.issues).toBe('write');
    expect(out.permissions?.contents).toBe('read');
    expect(out.needs).toBe('mistral-vibe');
    expect(out.if).toContain("needs.mistral-vibe.result == 'success'");
    expect(out.if).toContain("github.actor == 'NTinkicht'");
    expect(out.if).toContain('BINDING_EXACT_HEAD_REVIEW');
  });

  it('publishes from trusted main without model keys or PR checkout', () => {
    const model = workflow.jobs['mistral-vibe'];
    const out = workflow.jobs['publish-review'];
    const report = model.steps.find((s) => s.name === 'Post Mistral result');
    expect(report?.run).toContain('gh issue comment 11');
    expect(report?.run).toContain('source_report_id=');
    expect(out.steps[1]?.env?.SOURCE_REPORT_ID).toContain(
      'needs.mistral-vibe.outputs.source_report_id',
    );
    expect(report?.run).not.toContain('gh issue comment "$REVIEW_PR"');
    expect(out.steps).toHaveLength(2);
    const checkout = out.steps[0];
    const publish = out.steps[1];
    expect(checkout.uses).toContain('actions/checkout@');
    expect(checkout.with?.ref).toBe('main');
    expect(checkout.with?.['persist-credentials']).toBe(false);
    expect(publish.run).toContain('publish-mistral-review.py');
    expect(publish.env?.GH_TOKEN).toContain('secrets.GITHUB_TOKEN');
    const hasModelKey = out.steps.some((s) => s.env?.MISTRAL_API_KEY);
    expect(hasModelKey).toBe(false);
    const commands = out.steps.map((s) => s.run ?? '').join(' ');
    expect(commands).not.toContain('vibe ');
    expect(commands).not.toContain('npm ');
    expect(commands).not.toContain('gh pr merge');
  });

  it('blocks PR-controlled hooks and agent instructions', () => {
    const model = workflow.jobs['mistral-vibe'];
    const stage = model.steps.find(
      (s) => s.name === 'Stage only verified diff as data outside PR checkout',
    );
    const execute = model.steps.find(
      (s) =>
        s.name === 'Run Mistral Vibe in bounded read-only programmatic mode',
    );
    expect(stage?.run).toContain('/tmp/tabibi-mistral-clean-review');
    expect(stage?.run).toContain('stat.S_ISREG');
    expect(stage?.run).toContain('os.chmod');
    expect(execute?.run).toContain('--workdir "$VIBE_SAFE_WORKDIR"');
    expect(execute?.run).not.toContain('              --trust');
    expect(execute?.run).not.toContain('Consult VIBE.md');
    expect(execute?.run).toContain(
      'Inspect ONLY staged .tabibi_mistral_review.diff',
    );
    expect(execute?.run).not.toContain('--enabled-tools bash');
    expect(execute?.run).not.toContain('--enabled-tools write_file');
  });
});
