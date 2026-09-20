import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(
  '.github/workflows/savegrok-cloud-slack-bridge.yml',
  'utf8',
);

describe('SaveGrok cloud lease bridge', () => {
  it('accepts owner-authorized review leases without Grok credentials in Actions', () => {
    expect(workflow).toContain("github.actor == 'NTinkicht'");
    expect(workflow).toContain('github.event.issue.pull_request');
    expect(workflow).toContain('ROLE_LEASE_ASSIGNED');
    expect(workflow).toContain('capability: review');
    expect(workflow).toContain('source_lease_comment');
    expect(workflow).toContain('SLACK_CHATGPT_BOT_TOKEN');
    expect(workflow).not.toContain('XAI_API_KEY');
    expect(workflow).not.toContain('GROK_AUTH_JSON');
    expect(workflow).not.toContain('contents: write');
    expect(workflow).not.toContain('pull-requests: write');
  });

  it('requires a same-repo live SHA, nonauthor, and all three successful CI jobs', () => {
    expect(workflow).toContain("pr.get('head', {}).get('sha') != exact_sha");
    expect(workflow).toContain("pr.get('state') != 'open'");
    expect(workflow).toContain("pr.get('base', {}).get('ref') != 'main'");
    expect(workflow).toContain("'grok' in authors");
    expect(workflow).toContain("'Quality and build'");
    expect(workflow).toContain("'PostgreSQL integration'");
    expect(workflow).toContain("'Browser smoke'");
    expect(workflow).toContain('CLOUD_SIGNAL_SENT');
    expect(workflow).toContain('Grok Bot execution and review MUST be separately verified.');
  });

  it('parses the embedded lease validator without executing external actions', () => {
    const body = workflow.split("python3 - <<'PY'\n")[1]?.split('\n          PY')[0];
    expect(body).toBeDefined();
    const script = body
      ?.split('\n')
      .map((line) => line.replace(/^          /, ''))
      .join('\n');
    const check = spawnSync(
      'python3',
      ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'],
      { input: script, encoding: 'utf8' },
    );
    expect(check.status).toBe(0);
  });
});
