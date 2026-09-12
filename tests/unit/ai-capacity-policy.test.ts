import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const workflowDirectory = path.join(process.cwd(), '.github', 'workflows');
const forbiddenWorkflowPatterns = [
  { label: 'OpenRouter provider reference', pattern: /openrouter/i },
  { label: 'OpenRouter repository secret', pattern: /OPENROUTER_API_KEY/ },
  { label: 'OpenRouter PR-Agent key', pattern: /OPENROUTER__KEY/ },
  { label: 'Gemini API key automation', pattern: /(?:GEMINI|GOOGLE)_API_KEY/ },
  { label: 'Mistral API key automation', pattern: /MISTRAL_API_KEY/ },
  { label: 'Vertex AI paid route', pattern: /(?:vertexai|aiplatform\.googleapis\.com)/i },
];

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

      for (const { label, pattern } of forbiddenWorkflowPatterns) {
        lines.forEach((line, index) => {
          if (pattern.test(line)) violations.push(`${file}:${index + 1} ${label}`);
        });
      }
    }

    expect(violations).toEqual([]);
  });
});
