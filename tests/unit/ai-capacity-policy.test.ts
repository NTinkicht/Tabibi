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

const providerSecretWorkflowAllowlist = new Map([
  ['GEMINI_API_KEY', 'gemini-cli-wake.yml'],
  ['MISTRAL_API_KEY', 'mistral-vibe-wake.yml'],
]);

describe('AI capacity policy', () => {
  it('keeps active GitHub workflows free of unapproved metered-provider paths', () => {
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
          if (pattern.test(line))
            violations.push(`${file}:${index + 1} ${label}`);
        });
      }

      for (const [secretName, allowedWorkflow] of providerSecretWorkflowAllowlist) {
        lines.forEach((line, index) => {
          if (line.includes(secretName) && file !== allowedWorkflow) {
            violations.push(
              `${file}:${index + 1} ${secretName} is only allowed in ${allowedWorkflow}`,
            );
          }
        });
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps Gemini and Mistral unattended wakes owner-only, event-driven and read-only', () => {
    const wakePolicies = [
      {
        file: 'gemini-cli-wake.yml',
        mention: '@gemini-cli',
        guard: 'TABIBI_GEMINI_ZERO_BILLING_CONFIRMED',
        secret: 'GEMINI_API_KEY',
        readonlyMarker: '--approval-mode=plan',
      },
      {
        file: 'mistral-vibe-wake.yml',
        mention: '@mistral-vibe',
        guard: 'TABIBI_MISTRAL_PAYG_DISABLED_CONFIRMED',
        secret: 'MISTRAL_API_KEY',
        readonlyMarker: '--agent plan',
      },
    ];

    for (const policy of wakePolicies) {
      const content = fs.readFileSync(
        path.join(workflowDirectory, policy.file),
        'utf8',
      );

      expect(content).toContain('github.event.issue.number == 11');
      expect(content).toContain("github.actor == 'NTinkicht'");
      expect(content).toContain(policy.mention);
      expect(content).toContain(policy.guard);
      expect(content).toContain(policy.secret);
      expect(content).toContain(policy.readonlyMarker);
      expect(content).toMatch(/permissions:\s*[\s\S]*?contents:\s*read/);
      expect(content).not.toMatch(/contents:\s*write/);
      expect(content).not.toMatch(/^\s*schedule\s*:/m);
    }
  });
});
