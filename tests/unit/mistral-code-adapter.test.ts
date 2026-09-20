import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const yaml = createRequire(import.meta.url)('js-yaml') as {
  load: (value: string) => unknown;
};
const workflow = fs.readFileSync(
  '.github/workflows/mistral-scoped-code-adapter.yml',
  'utf8',
);
const parsed = yaml.load(workflow) as {
  on: { issue_comment: { types: string[] } };
  permissions: Record<string, string>;
  jobs: {
    'mistral-code': {
      if: string;
      steps: {
        name?: string;
        id?: string;
        if?: string;
        env?: Record<string, string>;
        run?: string;
        with?: Record<string, string>;
      }[];
    };
  };
};
const steps = parsed.jobs['mistral-code'].steps;
const named = (name: string) => {
  const found = steps.find((step) => step.name === name);
  if (!found) throw new Error(`Missing trusted stage: ${name}`);
  return found;
};

describe('Mistral scoped coding adapter is default-off and parent-controlled', () => {
  it('parses owner-only issue trigger and explicit activation guard', () => {
    expect(parsed.on.issue_comment.types).toEqual(['created']);
    expect(parsed.jobs['mistral-code'].if).toContain("github.actor == 'NTinkicht'");
    expect(parsed.jobs['mistral-code'].if).toContain(
      "github.event.issue.number == 11",
    );
    const gate = named('Validate owner lease and default-OFF guards');
    expect(gate.env?.ADAPTER_ENABLED).toContain(
      'vars.TABIBI_MISTRAL_CODE_ADAPTER_ENABLED',
    );
    expect(gate.env?.PAYG_DISABLED_CONFIRMED).toContain(
      'vars.TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED',
    );
    expect(gate.run).toContain('mistral-code-adapter.py selftest');
    expect(gate.run).toContain('mistral-code-adapter.py prepare');
  });

  it('keeps model read-only and all GitHub write credentials in the parent', () => {
    expect(parsed.permissions.contents).toBe('write');
    expect(parsed.permissions.issues).toBe('write');
    expect(parsed.permissions['pull-requests']).toBe('read');
    const model = named('Request a bounded NON-mutating code proposal from Mistral');
    expect(model.env).not.toHaveProperty('GH_TOKEN');
    expect(model.env?.MISTRAL_API_KEY).toContain('secrets.MISTRAL_API_KEY');
    expect(model.run).toContain('--agent plan');
    expect(model.run).toContain('--enabled-tools grep --enabled-tools read_file');
    expect(model.run).toContain('--max-turns 3');
    expect(model.run).not.toContain('--yolo');
    expect(model.run).not.toContain('--auto-approve');
    expect(model.run).not.toContain('git push');
    const patch = named("Validate model's exact edits in trusted parent");
    const publish = named(
      'Trusted parent fast-forward commit and push ONLY canonical branch',
    );
    expect(patch.env?.GH_TOKEN).toContain('secrets.GITHUB_TOKEN');
    expect(publish.env?.GH_TOKEN).toContain('secrets.GITHUB_TOKEN');
    expect(publish.if).toContain("steps.tests.outcome == 'success'");
    expect(publish.run).toContain('mistral-code-adapter.py publish');
  });

  it('requires actual deterministic tests before trusted parent push', () => {
    const tests = named(
      'Deterministic format, lint, types, unit/API tests and build',
    );
    expect(tests.if).toContain("steps.patch.outputs.ready == 'true'");
    for (const command of [
      'npm ci',
      'npm run format',
      'npm run lint',
      'npm run typecheck',
      'npm test',
      'npm run build',
      'git diff --check',
    ]) {
      expect(tests.run).toContain(command);
    }
    const ordinary = fs.readFileSync(
      '.github/workflows/mistral-vibe-wake.yml',
      'utf8',
    );
    expect(ordinary).toContain(
      "!contains(github.event.comment.body, 'MISTRAL_LEASED_CODE_V1')",
    );
  });

  it('runs parent verifier synthetic attack and fail-closed selftests', () => {
    const process = spawnSync('python3', ['scripts/mistral-code-adapter.py', 'selftest'], {
      encoding: 'utf8',
    });
    expect(process.status).toBe(0);
    expect(process.stdout).toContain('selftest passed');
    const parent = fs.readFileSync('scripts/mistral-code-adapter.py', 'utf8');
    expect(parent).toContain('MISTRAL_LEASED_CODE_V1');
    expect(parent).toContain('Material-Author: mistral-vibe');
    expect(parent).toContain('active_owner_lease');
    expect(parent).toContain('source.count(edit["old"]) != 1');
    expect(parent).toContain('stat.S_ISREG');
    expect(parent).toContain('current.is_symlink()');
    expect(parent).toContain('REDACT.search(result)');
    expect(parent).toContain('gh", "auth", "setup-git');
    expect(parent).not.toContain('--force');
  });
});
