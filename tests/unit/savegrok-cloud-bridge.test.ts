import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(
  '.github/workflows/savegrok-cloud-slack-bridge.yml',
  'utf8',
);

const yaml = createRequire(import.meta.url)('js-yaml') as {
  load: (source: string) => unknown;
};
const parsed = yaml.load(workflow) as {
  on: { issue_comment: { types: string[] } };
  permissions: Record<string, string>;
  jobs: {
    'notify-grok-cloud': {
      if: string;
      env: Record<string, string>;
      steps: { run?: string }[];
    };
  };
};
const bridge = parsed.jobs['notify-grok-cloud'];
const validator = bridge.steps.find((step) => step.run?.includes('python3'));
if (!validator?.run) {
  throw new Error('Missing executable Grok lease validator');
}
const trustedScript = validator.run;

describe('SaveGrok cloud lease bridge', () => {
  it('accepts owner-authorized review leases without Grok credentials in Actions', () => {
    expect(parsed.on.issue_comment.types).toEqual(['created']);
    expect(parsed.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      actions: 'read',
      issues: 'read',
    });
    expect(bridge.if).toContain("github.actor == 'NTinkicht'");
    expect(bridge.if).toContain('github.event.issue.pull_request');
    expect(bridge.env.GROK_CLOUD_BRIDGE_ENABLED).toContain(
      'vars.TABIBI_GROK_CLOUD_BRIDGE_ENABLED',
    );
    expect(bridge.env.SLACK_CHATGPT_BOT_TOKEN).toContain(
      'secrets.SLACK_CHATGPT_BOT_TOKEN',
    );
    expect(trustedScript).toContain("GROK_CLOUD_BRIDGE_ENABLED') != 'true'");
    expect(trustedScript).toContain('CLOUD_SIGNAL_SENT');
    expect(workflow).toContain('github.event.issue.pull_request');
    expect(workflow).toContain('ROLE_LEASE_ASSIGNED');
    expect(workflow).toContain('capability: review');
    expect(workflow).toContain('source_lease_comment');
    expect(workflow).toContain('SLACK_CHATGPT_BOT_TOKEN');
    expect(workflow).toContain('TABIBI_GROK_CLOUD_BRIDGE_ENABLED');
    expect(workflow).toContain("GROK_CLOUD_BRIDGE_ENABLED') != 'true'");
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
    expect(workflow).toContain('ROLE_LEASE_RELEASED');
    expect(workflow).toContain('ROLE_FAILOVER');
    expect(workflow).toContain('ROLE_LEASE_ASSIGNED');
    expect(workflow).toContain(
      "source_id = int(os.environ['LEASE_COMMENT_ID'])",
    );
    expect(workflow).toContain('for page in range(1, 21)');
    expect(workflow).toContain("run.get('run_attempt')");
    expect(workflow).toContain("latest.get('status') != 'completed'");
    expect(workflow).toContain('filter=latest&per_page=100');
    expect(workflow).toContain('CLOUD_SIGNAL_SENT');
    expect(workflow).toContain(
      'Grok Bot execution and review MUST be separately verified.',
    );
  });

  it('parses the embedded lease validator without executing external actions', () => {
    const body = trustedScript
      .split("python3 - <<'PY'\n")[1]
      ?.split('\nPY')[0];
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
