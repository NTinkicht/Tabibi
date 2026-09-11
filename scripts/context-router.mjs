#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const MAX_SLICE_LINES = 300;
const MAX_SEARCH_LINES = 80;
const MAX_COMPRESS_CHARS = 40_000;
const MAX_FILE_CHARS = 12_000;
const BUDGET_PATH = path.join(ROOT, '.tabibi', 'context-budget.json');
const METRICS_PATH = path.join(ROOT, '.tabibi', 'context-router-metrics.jsonl');

const sensitivePatterns = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:secrets?|credentials?|private[-_]?keys?)(?:\/|\.|$)/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /(?:patient|production)[-_]?(?:dump|export)/i,
  /(?:database|db)[-_]?dump/i,
];

function usage(exitCode = 1) {
  console.error(`Usage:
  node scripts/context-router.mjs search <query>
  node scripts/context-router.mjs profile <path> [path...]
  node scripts/context-router.mjs slice <path> <start-line> [line-count]
  node scripts/context-router.mjs compress <question> -- <path[@start-end]> [path...]

Compression is OFF by default. It requires TABIBI_CONTEXT_ALLOW_COPILOT=1 and a
local .tabibi/context-budget.json with remainingUnits > 0 and hardStop != true.`);
  process.exit(exitCode);
}

function repoPath(requested) {
  const absolute = path.resolve(ROOT, requested);
  const relative = path.relative(ROOT, absolute).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the repository: ${requested}`);
  }
  if (sensitivePatterns.some((pattern) => pattern.test(relative))) {
    throw new Error(
      `Sensitive path is not eligible for context routing: ${relative}`,
    );
  }
  return { absolute, relative };
}

function appendMetric(record) {
  try {
    fs.mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
    fs.appendFileSync(
      METRICS_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
      'utf8',
    );
  } catch {
    // Metrics are best-effort; routing must not depend on them.
  }
}

function search(query) {
  if (!query?.trim()) usage();
  const started = Date.now();
  const result = spawnSync(
    'git',
    ['grep', '-n', '-I', '--full-name', '--', query],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );

  // git grep returns 1 when there are no matches.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr?.trim() || 'git grep failed');
  }
  const lines = (result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(
      (line) =>
        !sensitivePatterns.some((pattern) =>
          pattern.test(line.split(':', 1)[0]),
        ),
    )
    .slice(0, MAX_SEARCH_LINES);
  process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
  appendMetric({
    operation: 'search',
    matchCount: lines.length,
    elapsedMs: Date.now() - started,
    modelInvoked: false,
  });
}

function profile(paths) {
  if (!paths.length) usage();
  const rows = [];
  for (const requested of paths) {
    const { absolute, relative } = repoPath(requested);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error(`Not a file: ${relative}`);
    const text = fs.readFileSync(absolute, 'utf8');
    rows.push({
      path: relative,
      bytes: stat.size,
      lines: text.split(/\r?\n/).length,
    });
  }
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  appendMetric({
    operation: 'profile',
    fileCount: rows.length,
    modelInvoked: false,
  });
}

function slice(requested, rawStart, rawCount = '120') {
  const start = Number(rawStart);
  const count = Number(rawCount);
  if (!Number.isSafeInteger(start) || start < 1)
    throw new Error('start-line must be >= 1');
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SLICE_LINES) {
    throw new Error(`line-count must be between 1 and ${MAX_SLICE_LINES}`);
  }
  const { absolute, relative } = repoPath(requested);
  const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
  const chosen = lines.slice(start - 1, start - 1 + count);
  for (let i = 0; i < chosen.length; i += 1) {
    process.stdout.write(`${start + i}: ${chosen[i]}\n`);
  }
  appendMetric({
    operation: 'slice',
    path: relative,
    start,
    lineCount: chosen.length,
    modelInvoked: false,
  });
}

function readBudget() {
  if (process.env.TABIBI_CONTEXT_ALLOW_COPILOT !== '1') {
    throw new Error(
      'Copilot compression is disabled. Set TABIBI_CONTEXT_ALLOW_COPILOT=1 only after confirming included allowance and paid overage is disabled.',
    );
  }
  if (!fs.existsSync(BUDGET_PATH)) {
    throw new Error(
      'Missing .tabibi/context-budget.json; compression fails closed when local budget state is unknown.',
    );
  }
  const budget = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8'));
  if (budget.hardStop === true)
    throw new Error('Local Copilot context hard stop is active.');
  if (
    !Number.isSafeInteger(budget.remainingUnits) ||
    budget.remainingUnits <= 0
  ) {
    throw new Error('No local Copilot context units remain.');
  }
  return budget;
}

function parseSpec(spec) {
  const match = /^(.*?)(?:@(\d+)-(\d+))?$/.exec(spec);
  if (!match) throw new Error(`Invalid path spec: ${spec}`);
  const requested = match[1];
  const start = match[2] ? Number(match[2]) : 1;
  const end = match[3] ? Number(match[3]) : start + 199;
  if (end < start || end - start + 1 > MAX_SLICE_LINES) {
    throw new Error(
      `Compression slice must be <= ${MAX_SLICE_LINES} lines: ${spec}`,
    );
  }
  return { requested, start, end };
}

function buildEvidence(specs) {
  let total = 0;
  const chunks = [];
  for (const spec of specs) {
    const { requested, start, end } = parseSpec(spec);
    const { absolute, relative } = repoPath(requested);
    const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
    let excerpt = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join('\n');
    if (excerpt.length > MAX_FILE_CHARS)
      excerpt = excerpt.slice(0, MAX_FILE_CHARS);
    if (total + excerpt.length > MAX_COMPRESS_CHARS) break;
    total += excerpt.length;
    chunks.push(
      `FILE ${relative} lines ${start}-${Math.min(end, lines.length)}\n${excerpt}`,
    );
  }
  if (!chunks.length)
    throw new Error('No eligible evidence excerpts were supplied.');
  return { text: chunks.join('\n\n'), chars: total, files: chunks.length };
}

function compress(question, specs) {
  const started = Date.now();
  const budget = readBudget();
  if (!question?.trim() || !specs.length) usage();
  const evidence = buildEvidence(specs);
  const prompt = `You are Tabibi's low-cost context compression worker. You are not an authority and must not propose architecture or merge verdicts.\n\nQuestion: ${question}\n\nReturn at most 500 tokens. Prefer bullet facts with exact file names and line ranges, relevant symbols, and an uncertainty section. Do not invent missing context.\n\nEVIDENCE:\n${evidence.text}`;

  const result = spawnSync(
    'copilot',
    ['-p', prompt, '-s', '--no-ask-user', '--model', 'gpt-5.6-luna'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
  );
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      'Copilot CLI is not installed; use deterministic retrieval instead.',
    );
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        'Copilot compression failed; no paid/provider fallback is permitted.',
    );
  }

  const nextBudget = { ...budget, remainingUnits: budget.remainingUnits - 1 };
  fs.mkdirSync(path.dirname(BUDGET_PATH), { recursive: true });
  fs.writeFileSync(
    BUDGET_PATH,
    `${JSON.stringify(nextBudget, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(result.stdout || '');
  appendMetric({
    operation: 'compress',
    evidenceChars: evidence.chars,
    fileCount: evidence.files,
    modelInvoked: true,
    model: 'gpt-5.6-luna',
    remainingUnits: nextBudget.remainingUnits,
    elapsedMs: Date.now() - started,
  });
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'search') search(args.join(' '));
  else if (command === 'profile') profile(args);
  else if (command === 'slice') slice(args[0], args[1], args[2]);
  else if (command === 'compress') {
    const separator = args.indexOf('--');
    if (separator < 1) usage();
    compress(args.slice(0, separator).join(' '), args.slice(separator + 1));
  } else usage();
} catch (error) {
  console.error(
    `context-router: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}
