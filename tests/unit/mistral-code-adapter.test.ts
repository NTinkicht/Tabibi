import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const yaml = createRequire(import.meta.url)('js-yaml') as {
  load: (value: string) => unknown;
};
type Step = {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  permissions: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  steps: Step[];
};
const workflow = fs.readFileSync(
  '.github/workflows/mistral-scoped-code-adapter.yml',
  'utf8',
);
const parsed = yaml.load(workflow) as {
  on: { issue_comment: { types: string[] } };
  permissions: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<'propose' | 'validate' | 'test' | 'publish' | 'report', Job>;
};
const { propose, validate, test, publish, report } = parsed.jobs;
const named = (job: Job, name: string) => {
  const found = job.steps.find((step) => step.name === name);
  if (!found) throw new Error(`Missing trusted stage: ${name}`);
  return found;
};

describe('Mistral code adapter uses owner per-WU leases', () => {
  it('accepts owner-only per-lease activation with PAYG disabled', () => {
    expect(parsed.on.issue_comment.types).toEqual(['created']);
    expect(propose.if).toContain("github.actor == 'NTinkicht'");
    expect(propose.if).toContain('github.event.issue.number == 11');
    expect(propose.if).toContain('MISTRAL_LEASED_CODE_V1');
    const gate = named(
      propose,
      'Validate owner per-WU lease and PAYG-disabled guard',
    );
    expect(gate.env).not.toHaveProperty('ADAPTER_ENABLED');
    expect(gate.env?.PAYG_DISABLED_CONFIRMED).toContain(
      'vars.TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED',
    );
    expect(gate.run).toContain('mistral-code-adapter.py selftest');
    expect(gate.run).toContain('mistral-code-adapter.py prepare');
    expect(propose.outputs?.ready).toContain('steps.model.outputs.exit_code');
    expect(validate.outputs?.ready).toContain('steps.patch.outputs.ready');
    expect(propose.outputs?.lease).toContain('steps.lease.outputs.lease');
    expect(propose.outputs?.paths).toContain('steps.lease.outputs.paths');
    expect(propose.concurrency?.group).toContain('github.event.comment.id');
    expect(propose.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('isolates the model and deterministic tests from ALL repository write tokens', () => {
    expect(parsed.permissions).toEqual({ contents: 'read' });
    for (const job of [propose, validate, test, publish, report]) {
      expect(job.env ?? {}).not.toHaveProperty('GH_TOKEN');
      expect(job.env ?? {}).not.toHaveProperty('MISTRAL_API_KEY');
    }
    expect(parsed.env ?? {}).not.toHaveProperty('GH_TOKEN');
    expect(parsed.env ?? {}).not.toHaveProperty('MISTRAL_API_KEY');
    expect(propose.permissions.contents).toBe('read');
    expect(validate.permissions.contents).toBe('read');
    expect(validate.permissions.issues).toBe('read');
    expect(test.permissions.contents).toBe('read');
    expect(test.permissions.issues).toBe('read');
    expect(propose.permissions['pull-requests']).toBe('read');
    expect(publish.permissions.contents).toBe('write');
    expect(publish.permissions.issues).toBe('write');
    expect(report.permissions.contents).toBe('read');
    expect(report.permissions.issues).toBe('write');
    expect(validate.needs).toBe('propose');
    expect(test.needs).toEqual(['propose', 'validate']);
    expect(publish.needs).toEqual(['propose', 'validate', 'test']);
    expect(publish.if).toContain("needs.test.result == 'success'");
    const model = named(
      propose,
      'Request a bounded NON-mutating code proposal from Mistral',
    );
    expect(model.env).not.toHaveProperty('GH_TOKEN');
    expect(model.env?.MISTRAL_API_KEY).toContain('secrets.MISTRAL_API_KEY');
    expect(model.env?.TASK_OBJECTIVE).toContain(
      'steps.lease.outputs.objective',
    );
    expect(model.run).toContain('--agent auto-approve');
    expect(model.run).not.toContain('--agent plan');
    expect(model.run).toContain('cd /tmp/tabibi-mistral-readonly');
    expect(model.run).toContain('env -u GITHUB_TOKEN -u GH_TOKEN');
    const modelCommand = (model.run ?? '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(modelCommand).not.toMatch(/\s--trust(?:\s|$)/);
    expect(model.run).not.toContain('VIBE_HOME="$GITHUB_WORKSPACE"');
    expect(model.run).toContain('Produce the EXACT edit payload');
    expect(model.run).toContain('--workdir /tmp/tabibi-mistral-readonly');
    expect(model.run).toContain(
      '--enabled-tools grep --enabled-tools read_file',
    );
    expect(model.run).toContain('--max-turns 8');
    expect(model.run).toContain('Vibe diagnostic categories=');
    expect(model.run).not.toContain('print(line)');
    expect(model.run).not.toContain('print(raw)');
    expect(model.run).not.toContain('--yolo');
    expect(model.run).not.toContain('--auto-approve');
    expect(model.run).not.toContain('--enabled-tools bash');
    expect(model.run).not.toContain('--enabled-tools write_file');
    expect(model.run).not.toContain('--enabled-tools edit');
    expect(model.run).not.toContain('git push');
    expect(propose.steps.some((s) => s.uses?.includes('upload-artifact'))).toBe(
      true,
    );
    expect(
      validate.steps.some((s) => s.uses?.includes('download-artifact')),
    ).toBe(true);
    expect(
      validate.steps.some((s) => s.uses?.includes('upload-artifact')),
    ).toBe(true);
    expect(test.steps.some((s) => s.uses?.includes('download-artifact'))).toBe(
      true,
    );
    expect(
      publish.steps.some((s) => s.uses?.includes('download-artifact')),
    ).toBe(true);
  });

  it('validates only leased paths before deterministic unprivileged testing', () => {
    const stage = named(propose, 'Stage ONLY allowlisted read paths for Vibe');
    expect(stage.run).toContain("os.environ['ALLOWED_PATHS']");
    expect(stage.run).toContain('current.is_symlink()');
    expect(stage.run).toContain('source.stat().st_nlink != 1');
    expect(stage.run).toContain('shutil.copyfile(source, dest)');
    const patch = named(
      validate,
      'Validate model exact edits in isolated trusted read-only parent',
    );
    expect(patch.run).toContain('mistral-code-adapter.py apply');
    expect(validate.steps[0]?.name).toBe(
      'Fresh trusted read-only runner checkout',
    );
    expect(
      propose.steps.some(
        (step) => step.env?.GH_TOKEN && step.name?.includes('patch'),
      ),
    ).toBe(false);
    const tests = named(
      test,
      'Unprivileged deterministic format lint typecheck unit/API and build',
    );
    expect(tests.if).toContain("steps.applied.outputs.ready == 'true'");
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
    const apply = named(
      test,
      'Re-validate and apply sealed patch without write-capable token',
    );
    expect(apply.run).toContain('mistral-code-adapter.py applyartifact');
    const verified = named(
      publish,
      'Re-verify same owner lease, SHA, allowlist and sealed patch',
    );
    expect(verified.run).toContain('mistral-code-adapter.py applyartifact');
    const push = named(
      publish,
      'Parent-only non-force canonical PR push AFTER isolated tests',
    );
    expect(push.if).toContain("steps.verified.outputs.ready == 'true'");
    expect(push.run).toContain('mistral-code-adapter.py publish');
    expect(push.env?.GH_TOKEN).toContain('secrets.GITHUB_TOKEN');
    expect(test.steps.some((step) => step.env?.MISTRAL_API_KEY)).toBe(false);
    expect(publish.steps.some((step) => step.env?.MISTRAL_API_KEY)).toBe(false);
    expect(
      publish.steps.some((step) => (step.run ?? '').includes('npm ')),
    ).toBe(false);
    const ordinary = fs.readFileSync(
      '.github/workflows/mistral-vibe-wake.yml',
      'utf8',
    );
    expect(ordinary).toContain(
      "!contains(github.event.comment.body, 'MISTRAL_LEASED_CODE_V1')",
    );
  });

  it('fails closed at runtime when PAYG-off confirmation is absent', () => {
    const dir = fs.mkdtempSync('/tmp/tabibi-mistral-payg-');
    const output = `${dir}/result.txt`;
    try {
      fs.writeFileSync(output, '');
      for (const confirmation of ['', 'false']) {
        fs.writeFileSync(output, '');
        const run = spawnSync(
          'python3',
          ['scripts/mistral-code-adapter.py', 'prepare'],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              GITHUB_REPOSITORY: 'NTinkicht/Tabibi',
              GITHUB_OUTPUT: output,
              DISPATCH_BODY: 'invalid dispatch must not be parsed',
              PAYG_DISABLED_CONFIRMED: confirmation,
            },
          },
        );
        expect(run.status, run.stderr).toBe(0);
        expect(fs.readFileSync(output, 'utf8')).toContain(
          'status=CONFIG_BLOCKED',
        );
        expect(fs.readFileSync(output, 'utf8')).not.toContain(
          'LEASE_OR_TARGET_BLOCKED',
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs parent synthetic attack and fail-closed security selftest', () => {
    const testRun = spawnSync(
      'python3',
      ['scripts/mistral-code-adapter.py', 'selftest'],
      { encoding: 'utf8' },
    );
    expect(testRun.status, testRun.stderr).toBe(0);
    expect(testRun.stdout).toContain('selftest passed');
    const parent = fs.readFileSync('scripts/mistral-code-adapter.py', 'utf8');
    for (const evidence of [
      'MISTRAL_LEASED_CODE_V1',
      'Material-Author: mistral-vibe',
      'active_owner_lease',
      'replay_owner_lease',
      'LEASE_EVENT_LINE',
      'Overlapping active implementation leases',
      'source.count(edit["old"]) != 1',
      'stat.S_ISREG',
      'metadata.st_nlink != 1',
      'current.is_symlink()',
      'REDACT.search(result)',
      'mistral-validated.json',
      'def apply_patch(',
      'if mode == "applyartifact":',
      'def pr_current(',
      'gh", "auth", "setup-git',
    ]) {
      expect(parent).toContain(evidence);
    }
    expect(parent).not.toContain('--force');
    expect(parent).not.toContain('ADAPTER_ENABLED');
    expect(parent).toContain('PAYG_DISABLED_CONFIRMED');
  });
});
