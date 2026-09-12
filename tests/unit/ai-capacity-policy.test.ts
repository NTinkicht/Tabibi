import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const workflowDirectory = path.join(process.cwd(), '.github', 'workflows');
const globallyForbiddenWorkflowPatterns = [
  { label: 'OpenRouter provider reference', pattern: /openrouter/i },
  { label: 'OpenRouter repository secret', pattern: /OPENROUTER_API_KEY/ },
  { label: 'OpenRouter PR-Agent key', pattern: /OPENROUTER__KEY/ },
  { label: 'Google/Vertex API key route', pattern: /GOOGLE_API_KEY/ },
  {
    label: 'Vertex AI paid route',
    pattern: /(?:vertexai|aiplatform\.googleapis\.com)/i,
  },
];

const providerSecretWorkflowAllowlist = [
  { secret: 'GEMINI_API_KEY', workflow: 'gemini-cli-wake.yml' },
  { secret: 'MISTRAL_API_KEY', workflow: 'mistral-vibe-wake.yml' },
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
          if (line.includes(allowed.secret) && file !== allowed.workflow) {
            const location = `${file}:${index + 1}`;
            violations.push(`${location} ${allowed.secret} workflow violation`);
          }
        });
      }
    }

    expect(violations).toEqual([]);
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
    expect(content).toContain('--workdir "$GITHUB_WORKSPACE"');
    expect(content).not.toContain('--agent plan');
    expect(content).toContain("text.replace(secret, '[REDACTED]')");
    expect(content).toContain(
      'PAYG remains disabled and no paid fallback was attempted',
    );
  });
});
