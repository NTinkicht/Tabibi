import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(
  '.github/workflows/mistral-vibe-code.yml',
  'utf8',
);
const helper = fs.readFileSync('scripts/mistral-code-lease.py', 'utf8');

describe('Mistral bounded coding adapter', () => {
  it('keeps the lane owner-only, default-off and separate from review', () => {
    expect(workflow).toContain("github.event.issue.number == 11");
    expect(workflow).toContain("github.actor == 'NTinkicht'");
    expect(workflow).toContain('MISTRAL_CODE_LEASE_V1');
    expect(workflow).toContain('TABIBI_MISTRAL_CODE_ADAPTER_ENABLED');
    expect(workflow).toContain('TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toContain('--auto-approve');
    expect(workflow).not.toContain('--yolo');
    expect(workflow).not.toContain('schedule:');
  });

  it('gives the model reads only and leaves writes to trusted parent steps', () => {
    expect(workflow).toContain('enabled_tools = ["grep", "read_file"]');
    expect(workflow).toContain('--enabled-tools grep');
    expect(workflow).toContain('--enabled-tools read_file');
    expect(workflow).not.toContain('--enabled-tools shell');
    expect(workflow).not.toContain('--enabled-tools write_file');
    expect(workflow).toContain('python3 /tmp/tabibi-mistral-code-lease.py apply');
    expect(workflow).toContain('python3 /tmp/tabibi-mistral-code-lease.py recheck');
    expect(workflow).toContain('gh auth setup-git');
    expect(workflow).toContain('Material-Author: mistral-vibe');
    expect(workflow).not.toContain('git push --force');
  });

  it('fails closed on branch, path, patch and provenance boundaries', () => {
    for (const marker of [
      'MAX_PATHS = 6',
      'MAX_PATCH_BYTES = 80_000',
      'stale/noncanonical PR target',
      'symlink path rejected',
      'changed paths outside allowlist',
      'coding proof must change production src/',
      'coding proof must add/change deterministic tests',
      'secret-like material in proposed patch',
      'exactly one patch envelope required',
      'STALE_SHA',
    ]) {
      expect(helper).toContain(marker);
    }
    const check = spawnSync(
      'python3',
      ['scripts/mistral-code-lease.py', 'selftest'],
      { encoding: 'utf8' },
    );
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('mistral code lease selftest passed');
  });

  it('uses fixed test profiles and never executes a dispatch-supplied command', () => {
    expect(helper).toContain('"unit": ["npm", "run", "test:unit"]');
    expect(helper).toContain('"api": ["npm", "run", "test:api"]');
    expect(helper).toContain(
      '"public-e2e": ["npx", "playwright", "test", "tests/e2e/public-discovery-landing.spec.ts"]',
    );
    expect(workflow).toContain('case "$TEST_PROFILE" in');
    expect(workflow).not.toContain('eval "$TEST_PROFILE"');
    expect(workflow).not.toContain('bash -c "$TEST_PROFILE"');
  });
});
