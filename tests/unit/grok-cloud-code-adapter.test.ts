import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const yaml = createRequire(import.meta.url)('js-yaml') as {
  load: (text: string) => unknown;
};
const source = fs.readFileSync(
  '.github/workflows/grok-cloud-code-proposal.yml',
  'utf8',
);
type Step = {
  name?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
};
const parsed = yaml.load(source) as {
  on: { issue_comment: { types: string[] } };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      permissions: Record<string, string>;
      concurrency?: Record<string, string | boolean>;
      steps: Step[];
    }
  >;
};

describe('Grok cloud proposal uses a separate trusted parent', () => {
  it('only accepts owner comments on existing PRs with a code marker', () => {
    expect(parsed.on.issue_comment.types).toEqual(['created']);
    expect(parsed.permissions).toEqual({ contents: 'read' });
    const job = parsed.jobs.propose;
    expect(job.if).toContain("github.actor == 'NTinkicht'");
    expect(job.if).toContain('github.event.issue.pull_request != null');
    expect(job.if).toContain('GROK_CLOUD_CODE_PROPOSAL_V1');
    expect(job.concurrency?.group).toContain('github.event.issue.number');
    expect(job.concurrency?.['cancel-in-progress']).toBe(false);
    const lease = job.steps.find((step) => step.id === 'lease');
    expect(lease?.env?.EVENT_PR).toContain('github.event.issue.number');
    expect(lease?.run).toContain('grok-cloud-code-adapter.py prepare');
    const stage = job.steps.find((step) => step.id === 'stage');
    expect(stage?.run).toContain('UNTRUSTED_PROPOSAL_OVERSIZED');
    expect(stage?.run).toContain('write_text(raw');
  });

  it('separates untrusted tests from privileged parent publishing', () => {
    const { propose, validate, test, publish, report } = parsed.jobs;
    for (const job of [propose, validate, test]) {
      expect(job.permissions.contents).toBe('read');
      expect(
        job.steps.some((step) =>
          (step.run ?? '').includes('gh auth setup-git'),
        ),
      ).toBe(false);
    }
    expect(publish.permissions.contents).toBe('write');
    expect(report.permissions.contents).toBe('read');
    expect(test.needs).toEqual(['propose', 'validate']);
    expect(publish.needs).toEqual(['propose', 'validate', 'test']);
    expect(publish.if).toContain("needs.test.result == 'success'");
    const push = publish.steps.find((step) => step.id === 'publish');
    expect(push?.run).toContain('grok-cloud-code-adapter.py publish');
    expect(push?.env?.GH_TOKEN).toContain('secrets.GITHUB_TOKEN');
    expect(source).not.toContain('XAI_API_KEY');
    expect(source).not.toContain('GROK_AUTH_JSON');
    expect(source).not.toContain('SLACK_CHATGPT_BOT_TOKEN');
    expect(source).toContain('grok-untrusted-proposal');
    expect(source).toContain('grok-validated-patch');
    expect(source).toContain('npm run typecheck');
    expect(source).toContain('npm run format');
    expect(source).toContain('npm test');
  });

  it('selftests exact edits, symlinks and owner lease replay', () => {
    const output = spawnSync(
      'python3',
      ['scripts/grok-cloud-code-adapter.py', 'selftest'],
      { encoding: 'utf8' },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(output.stdout).toContain('selftest passed');
    const adapter = fs.readFileSync(
      'scripts/grok-cloud-code-adapter.py',
      'utf8',
    );
    for (const invariant of [
      'GROK_CLOUD_CODE_PROPOSAL_V1',
      'source_lease_id',
      'EVENT_PR',
      'active_owner_lease',
      'Overlapping active implementation leases',
      'Material-Author: grok',
      'REDACT.search(result)',
      'current.is_symlink()',
      'stat.S_ISREG',
      'gh", "auth", "setup-git',
    ]) {
      expect(adapter).toContain(invariant);
    }
    expect(adapter).not.toContain('MISTRAL_API_KEY');
    expect(adapter).not.toContain('ADAPTER_ENABLED');
    expect(adapter).not.toContain('--force');
  });
});
