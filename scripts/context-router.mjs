#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const ROOT_REAL = fs.realpathSync(ROOT);
const MAX_SLICE_LINES = 300;
const MAX_SEARCH_LINES = 80;
const MAX_COMPRESS_CHARS = 40_000;
const MAX_FILE_CHARS = 12_000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const STATE_DIR =
  process.env.TABIBI_CONTEXT_TEST_MODE === '1' &&
  process.env.TABIBI_CONTEXT_STATE_DIR
    ? path.resolve(process.env.TABIBI_CONTEXT_STATE_DIR)
    : path.join(ROOT, '.tabibi');
const BUDGET_PATH = path.join(STATE_DIR, 'context-budget.json');
const BUDGET_LOCK_PATH = path.join(STATE_DIR, 'context-budget.lock');
const BUDGET_GATE_PATH = path.join(STATE_DIR, 'context-budget.gate');
const METRICS_PATH = path.join(STATE_DIR, 'context-router-metrics.jsonl');

const sensitivePatterns = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.tabibi(?:\/|$)/i,
  /(^|\/)(?:secrets?|credentials?|private[-_]?keys?)(?:\/|\.|$)/i,
  /\.(?:pem|p12|pfx|key)$/i,
  /(?:^|\/)(?:patient|patients)[-_]?(?:record|records|data|fixture|fixtures|payload|payloads|export|exports|dump|dumps|snapshot|snapshots|backup|backups)(?:[-_.\/]|$)/i,
  /(?:^|\/)[^/]*patient[^/]*\.(?:json|csv|ndjson|sql|xlsx?|parquet)$/i,
  /(?:^|\/)(?:provider|providers|notification|notifications|webhook|webhooks)[-_]?(?:payload|payloads|response|responses|event|events|export|exports|dump|dumps)(?:[-_.\/]|$)/i,
  /(?:^|\/)[^/]*(?:provider|webhook)[^/]*\.(?:json|csv|ndjson|sql)$/i,
  /(?:production|prod)[-_]?(?:dump|export|data|snapshot|backup)/i,
  /(?:database|db)[-_]?(?:dump|export|backup)/i,
];

function usage(exitCode = 1) {
  console.error(`Usage:
  node scripts/context-router.mjs search <query>
  node scripts/context-router.mjs profile <path> [path...]
  node scripts/context-router.mjs slice <path> <start-line> [line-count]
  node scripts/context-router.mjs compress <question> -- <path[@start-end]> [path...]

Compression is OFF by default. Prefer deterministic retrieval and the verified
Headroom shadow path first. Copilot/Luna additionally requires
TABIBI_CONTEXT_ALLOW_COPILOT=1 and a local budget with remainingUnits > 0.`);
  process.exit(exitCode);
}

function relativeInside(root, target, label) {
  const relative = path.relative(root, target).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return relative;
}

function assertNonSensitive(relative) {
  if (sensitivePatterns.some((pattern) => pattern.test(relative))) {
    throw new Error(
      `Sensitive path is not eligible for context routing: ${relative}`,
    );
  }
}

function repoPath(requested) {
  const lexicalAbsolute = path.resolve(ROOT, requested);
  const lexicalRelative = relativeInside(
    ROOT,
    lexicalAbsolute,
    `Path ${requested}`,
  );
  assertNonSensitive(lexicalRelative);

  const realAbsolute = fs.realpathSync(lexicalAbsolute);
  const realRelative = relativeInside(
    ROOT_REAL,
    realAbsolute,
    `Resolved target for ${requested}`,
  );
  assertNonSensitive(realRelative);

  return {
    absolute: realAbsolute,
    relative: lexicalRelative,
    resolvedRelative: realRelative,
  };
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
  if (!Number.isSafeInteger(start) || start < 1) {
    throw new Error('start-line must be >= 1');
  }
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

function validateBudget(budget) {
  if (budget.hardStop === true) {
    throw new Error('Local Copilot context hard stop is active.');
  }
  if (
    !Number.isSafeInteger(budget.remainingUnits) ||
    budget.remainingUnits <= 0
  ) {
    throw new Error('No local Copilot context units remain.');
  }
  return budget;
}

function readBudgetUnsafe() {
  if (!fs.existsSync(BUDGET_PATH)) {
    throw new Error(
      'Missing local context budget; Copilot compression fails closed when budget state is unknown.',
    );
  }
  return validateBudget(JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8')));
}

function writeBudgetAtomic(budget) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temp = `${BUDGET_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(budget, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temp, BUDGET_PATH);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // The successful rename removes the temporary path.
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireBudgetGate() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    const fd = fs.openSync(BUDGET_GATE_PATH, 'wx', 0o600);
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`,
    );
    return fd;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    throw new Error(
      'Copilot budget lock acquisition/recovery gate is busy or abandoned; fail closed. Verify no context-router process is running before manually removing the local gate file.',
    );
  }
}

function releaseBudgetGate(fd) {
  try {
    fs.closeSync(fd);
  } finally {
    try {
      fs.unlinkSync(BUDGET_GATE_PATH);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function createBudgetLock() {
  const fd = fs.openSync(BUDGET_LOCK_PATH, 'wx', 0o600);
  fs.writeFileSync(
    fd,
    `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`,
  );
  return fd;
}

function recoverStaleBudgetLock() {
  try {
    const metadata = JSON.parse(fs.readFileSync(BUDGET_LOCK_PATH, 'utf8'));
    const age = Date.now() - Number(metadata.createdAtMs);
    if (!Number.isFinite(age) || age < LOCK_STALE_MS) return false;
    if (processIsAlive(Number(metadata.pid))) return false;

    const stalePath = `${BUDGET_LOCK_PATH}.stale-${process.pid}-${Date.now()}`;
    fs.renameSync(BUDGET_LOCK_PATH, stalePath);
    fs.unlinkSync(stalePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

function acquireBudgetLock() {
  const gateFd = acquireBudgetGate();
  try {
    try {
      return createBudgetLock();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!recoverStaleBudgetLock()) {
        throw new Error(
          'Copilot context budget reservation is already in progress; fail closed and retry later.',
        );
      }
      return createBudgetLock();
    }
  } finally {
    releaseBudgetGate(gateFd);
  }
}

function releaseBudgetLock(fd) {
  try {
    fs.closeSync(fd);
  } finally {
    try {
      fs.unlinkSync(BUDGET_LOCK_PATH);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function withBudgetReservation(action) {
  if (process.env.TABIBI_CONTEXT_ALLOW_COPILOT !== '1') {
    throw new Error(
      'Copilot compression is disabled. Explicit opt-in is required and paid overage must remain disabled.',
    );
  }

  const lockFd = acquireBudgetLock();
  let originalBudget;
  try {
    originalBudget = readBudgetUnsafe();
    const reservedBudget = {
      ...originalBudget,
      remainingUnits: originalBudget.remainingUnits - 1,
    };
    writeBudgetAtomic(reservedBudget);

    try {
      return action(reservedBudget);
    } catch (error) {
      // Ordinary invocation failures refund the reservation while the exclusive
      // lock is still held. A hard process crash leaves the unit consumed and
      // the stale lock fail-closed; stale-lock recovery never refunds it.
      writeBudgetAtomic(originalBudget);
      throw error;
    }
  } finally {
    releaseBudgetLock(lockFd);
  }
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
    if (excerpt.length > MAX_FILE_CHARS) {
      excerpt = excerpt.slice(0, MAX_FILE_CHARS);
    }
    if (total + excerpt.length > MAX_COMPRESS_CHARS) break;
    total += excerpt.length;
    chunks.push(
      `FILE ${relative} lines ${start}-${Math.min(end, lines.length)}\n${excerpt}`,
    );
  }
  if (!chunks.length) {
    throw new Error('No eligible evidence excerpts were supplied.');
  }
  return { text: chunks.join('\n\n'), chars: total, files: chunks.length };
}

function compress(question, specs) {
  if (!question?.trim() || !specs.length) usage();
  const started = Date.now();
  const evidence = buildEvidence(specs);
  const prompt = `You are Tabibi's low-cost context compression worker. You are not an authority and must not propose architecture or merge verdicts.\n\nQuestion: ${question}\n\nReturn at most 500 tokens. Prefer bullet facts with exact file names and line ranges, relevant symbols, and an uncertainty section. Do not invent missing context.\n\nEVIDENCE:\n${evidence.text}`;

  const { result, remainingUnits } = withBudgetReservation((reservedBudget) => {
    const result = spawnSync(
      'copilot',
      [
        '-p',
        prompt,
        '-s',
        '--no-ask-user',
        '--no-custom-instructions',
        '--no-auto-update',
        '--no-remote',
        '--no-remote-export',
        '--model',
        'gpt-5.6-luna',
      ],
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
    return { result, remainingUnits: reservedBudget.remainingUnits };
  });

  process.stdout.write(result.stdout || '');
  appendMetric({
    operation: 'compress',
    evidenceChars: evidence.chars,
    fileCount: evidence.files,
    modelInvoked: true,
    model: 'gpt-5.6-luna',
    remainingUnits,
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
