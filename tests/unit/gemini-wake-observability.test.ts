import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const workflowPath = path.join(
  process.cwd(),
  '.github',
  'workflows',
  'gemini-cli-wake.yml',
);

describe('Gemini unattended wake observability', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  it('streams only structured operational progress with a bounded actor runtime', () => {
    expect(workflow).toContain('--output-format stream-json');
    expect(workflow).toContain('timeout --signal=TERM --kill-after=15s 600s');
    expect(workflow).toContain('Gemini CLI heartbeat');
    expect(workflow).toContain('[gemini] session started model=');
    expect(workflow).toContain('[gemini] tool_use #');
    expect(workflow).toContain('[gemini] tool_result status=');
    expect(workflow).toContain('[gemini] result status=');
    expect(workflow).toContain('timeout-minutes: 15');
  });

  it('redacts live content while retaining the final assistant result', () => {
    expect(workflow).toContain('output.write(event.content)');
    expect(workflow).toContain('/tmp/tabibi-gemini-error.txt');
    expect(workflow).toContain('live content redacted');
    expect(workflow).not.toContain('console.log(event.content)');
    expect(workflow).not.toContain('console.log(event.parameters)');
    expect(workflow).not.toContain('console.log(event.output)');
    expect(workflow).not.toContain('console.log(event.message)');
  });

  it('keeps the existing zero-billing and read-only policy boundary', () => {
    expect(workflow).toContain('TABIBI_GEMINI_ZERO_BILLING_CONFIRMED');
    expect(workflow).toContain('GEMINI_API_KEY');
    expect(workflow).toContain('--approval-mode=default');
    expect(workflow).not.toContain('--approval-mode=plan');
    expect(workflow).toContain('--policy /tmp/tabibi-gemini-policy.toml');
    expect(workflow).toContain('toolName = "*"');
    expect(workflow).toContain('decision = "deny"');
    expect(workflow).toContain(
      'toolName = ["glob", "grep_search", "list_directory", "read_file", "read_many_files"]',
    );
  });
});
