import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync(
  '.github/workflows/openrouter-review-council.yml',
  'utf8',
);
const script = readFileSync('scripts/openrouter-review-council.mjs', 'utf8');

test('comment-triggered OpenRouter spend is owner-gated', () => {
  assert.match(workflow, /author_association == 'OWNER'/);
  assert.match(workflow, /OPENROUTER_COUNCIL/);
});

test('API key comes from a secret and is never hard-coded', () => {
  assert.match(workflow, /secrets\.OPENROUTER_API_KEY/);
  assert.doesNotMatch(script, /Authorization:\s*[`'"]Bearer\s+sk-or-v1-/);
});

test('council stays explicitly advisory', () => {
  assert.match(
    script,
    /Advisory only — NOT a gating review and NOT merge authority/,
  );
  assert.match(script, /Do not emit PASS\/MERGE_READY/);
});

test('diff, outputs, and provider error text are bounded/redacted', () => {
  assert.match(script, /MAX_DIFF_CHARS = 60000/);
  assert.match(script, /MAX_ERROR_TEXT_CHARS = 500/);
  assert.match(script, /replaceAll\(apiKey, REDACTED\)/);
  assert.match(script, /max_tokens/);
});
