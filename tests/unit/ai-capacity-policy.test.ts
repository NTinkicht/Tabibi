import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const workflowDirectory = path.join(process.cwd(), '.github', 'workflows');
const yaml = createRequire(import.meta.url)('js-yaml') as {
  load: (source: string) => unknown;
};
const globallyForbiddenWorkflowPatterns = [
  { label: 'OpenRouter provider reference', pattern: /openrouter/i },
  { label: 'OpenRouter repository secret', pattern: /OPENROUTER_API_KEY/ },
  { label: 'OpenRouter PR-Agent key', pattern: /OPENROUTER__KEY/ },
  { label: 'Google/Vertex API key route', pattern: /GOOGLE_API_KEY/ },
  { label: 'xAI API key route', pattern: /XAI_API_KEY/ },
  {
    label: 'Vertex AI paid route',
    pattern: /(?:vertexai|aiplatform\.googleapis\.com)/i,
  },
];

const providerSecretWorkflowAllowlist = [
  { secret: 'GEMINI_API_KEY', workflows: ['gemini-cli-wake.yml'] },
  {
    secret: 'MISTRAL_API_KEY',
    workflows: ['mistral-vibe-wake.yml', 'mistral-scoped-code-adapter.yml'],
  },
];

describe('AI capacity policy', () => {
  it('blocks unapproved metered-provider workflow paths', () => {
    const workflowFiles = fs
      .readdirSync(workflowDirectory)
      .filter((file) => /\.ya?ml$/i.test(file));
    const violations: string[] = [];

    for (const file of workflowFiles) {
      const workflowPath = path.join(workflowDirectory, file);
      const content = fs.readFileSync(workflowPath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (const { label, pattern } of globallyForbiddenWorkflowPatterns) {
        lines.forEach((line, index) => {
          if (pattern.test(line)) {
            violations.push(`${file}:${index + 1} ${label}`);
          }
        });
      }

      for (const allowed of providerSecretWorkflowAllowlist) {
        lines.forEach((line, index) => {
          if (
            line.includes(allowed.secret) &&
            !allowed.workflows.includes(file)
          ) {
            const location = `${file}:${index + 1}`;
            violations.push(`${location} ${allowed.secret} workflow violation`);
          }
        });
      }
    }

    expect(violations).toEqual([]);
  });

  it('allows only the bounded SaveGrok cloud signal, never Grok model execution', () => {
    const files = fs
      .readdirSync(workflowDirectory)
      .filter((file) => /\.ya?ml$/i.test(file));
    expect(files.filter((file) => /grok/i.test(file))).toEqual([
      'grok-cloud-code-proposal.yml',
      'savegrok-cloud-slack-bridge.yml',
    ]);
    const grokCode = fs.readFileSync(
      path.join(workflowDirectory, 'grok-cloud-code-proposal.yml'),
      'utf8',
    );
    expect(grokCode).toContain('GROK_CLOUD_CODE_PROPOSAL_V1');
    expect(grokCode).toContain('grok-cloud-code-adapter.py');
    expect(grokCode).toContain('source');
    expect(grokCode).not.toContain('XAI_API_KEY');
    expect(grokCode).not.toContain('GROK_AUTH_JSON');
    expect(grokCode).not.toContain('SLACK_CHATGPT_BOT_TOKEN');
    const bridge = fs.readFileSync(
      path.join(workflowDirectory, 'savegrok-cloud-slack-bridge.yml'),
      'utf8',
    );
    const parsed = yaml.load(bridge) as {
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
    const job = parsed.jobs['notify-grok-cloud'];
    expect(parsed.on.issue_comment.types).toEqual(['created']);
    expect(parsed.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      actions: 'read',
      issues: 'read',
    });
    expect(job.if).toContain("github.actor == 'NTinkicht'");
    expect(job.env.GROK_CLOUD_BRIDGE_ENABLED).toContain(
      'vars.TABIBI_GROK_CLOUD_BRIDGE_ENABLED',
    );
    expect(job.steps).toHaveLength(1);
    const code = job.steps[0]?.run;
    expect(code).toContain('CLOUD_SIGNAL_SENT');
    expect(code).toContain("GROK_CLOUD_BRIDGE_ENABLED') != 'true'");
    expect(code).not.toContain('grok -p');
    expect(code).not.toContain('XAI_API_KEY');
    expect(code).not.toContain('GROK_AUTH_JSON');
    expect(bridge).toContain('SLACK_CHATGPT_BOT_TOKEN');
    expect(bridge).toContain("github.actor == 'NTinkicht'");
    expect(bridge).toContain('CLOUD_SIGNAL_SENT');
    expect(bridge).not.toContain('grok -p');
    expect(bridge).not.toContain('XAI_API_KEY');
    expect(bridge).not.toContain('GROK_AUTH_JSON');
    expect(bridge).not.toContain('contents: write');
  });

  it('keeps external actor wakes owner-only and read-only', () => {
    const wakePolicies = [
      {
        file: 'gemini-cli-wake.yml',
        mention: '@gemini-cli',
        guard: 'TABIBI_GEMINI_ZERO_BILLING_CONFIRMED',
        secret: 'GEMINI_API_KEY',
        readonlyMarker: '--approval-mode=default',
        hardeningMarkers: [
          '--policy /tmp/tabibi-gemini-policy.toml',
          'toolName = "*"',
          'decision = "deny"',
          'read_many_files',
          '--output-format stream-json',
          "text.replace(secret, '[REDACTED]')",
          '/tmp/tabibi-gemini-public.txt',
        ],
      },
      {
        file: 'mistral-vibe-wake.yml',
        mention: '@mistral-vibe',
        guard: 'TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED',
        secret: 'MISTRAL_API_KEY',
        readonlyMarker: '--enabled-tools grep',
        hardeningMarkers: [
          '--enabled-tools read_file',
          '--agent plan',
          'enabled_tools = ["grep", "read_file"]',
          '--workdir "$GITHUB_WORKSPACE"',
          'https://console.mistral.ai/api/vibe/whoami',
          'VIBE_HOME: /tmp/tabibi-vibe-home',
          'enable_telemetry = false',
          "text.replace(secret, '[REDACTED]')",
        ],
      },
    ];

    for (const policy of wakePolicies) {
      const workflowPath = path.join(workflowDirectory, policy.file);
      const content = fs.readFileSync(workflowPath, 'utf8');

      expect(content).toContain('github.event.issue.number == 11');
      expect(content).toContain("github.actor == 'NTinkicht'");
      expect(content).toContain(policy.mention);
      expect(content).toContain(policy.guard);
      expect(content).toContain(policy.secret);
      expect(content).toContain(policy.readonlyMarker);
      for (const marker of policy.hardeningMarkers) {
        expect(content).toContain(marker);
      }
      expect(content).toMatch(/permissions:\s*[\s\S]*?contents:\s*read/);
      expect(content).not.toMatch(/contents:\s*write/);
      expect(content).not.toMatch(/^\s*schedule\s*:/m);
    }
  });

  it('uses policy enforcement instead of non-interactive Gemini plan mode', () => {
    const workflowPath = path.join(workflowDirectory, 'gemini-cli-wake.yml');
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain('--approval-mode=default');
    expect(content).not.toContain('--approval-mode=plan');
    expect(content).toContain('toolName = "*"');
    expect(content).toContain('decision = "deny"');
    expect(content).toContain(
      'toolName = ["glob", "grep_search", "list_directory", "read_file", "read_many_files"]',
    );
  });

  it('limits unattended Mistral execution to read-only repository tools', () => {
    const workflowPath = path.join(workflowDirectory, 'mistral-vibe-wake.yml');
    const content = fs.readFileSync(workflowPath, 'utf8');
    const enabledTools = [
      ...content.matchAll(/--enabled-tools\s+([a-zA-Z0-9_-]+)/g),
    ].map((match) => match[1]);

    expect(enabledTools).toEqual(['grep', 'read_file']);
    expect(content).toContain('enabled_tools = ["grep", "read_file"]');
    expect(content).toContain('--agent plan');
    expect(content).not.toContain('--auto-approve');
    expect(content).not.toContain('--yolo');
    expect(content).toContain('--workdir "$GITHUB_WORKSPACE"');
    expect(content).toContain("text.replace(secret, '[REDACTED]')");
    expect(content).toContain(
      'PAYG remains disabled and no paid fallback was attempted',
    );
  });

  it('classifies Mistral runtime failures without conflating them with capacity', () => {
    const workflowPath = path.join(workflowDirectory, 'mistral-vibe-wake.yml');
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain('status="AUTH_BLOCKED"');
    expect(content).toContain('status="ENTITLEMENT_BLOCKED"');
    expect(content).toContain('status="CAPACITY_DEGRADED"');
    expect(content).toContain('status="WAKE_TIMEOUT"');
    expect(content).toContain('status="CLI_INCOMPATIBLE"');
    expect(content).toContain('status="EXECUTION_FAILED"');
    expect(content).toContain(
      'reason="Mistral Vibe runtime failed with an unclassified nonzero exit"',
    );
    expect(content).toContain(
      'reason="Mistral included capacity is unavailable or exhausted"',
    );
    expect(content).toContain(
      '${ACTOR_STATUS:-EXECUTION_FAILED} - ${ACTOR_REASON:-Mistral Vibe exited without a usable result}',
    );
    expect(content).not.toContain('CAPACITY_DEGRADED - ${ACTOR_REASON');
  });
});
