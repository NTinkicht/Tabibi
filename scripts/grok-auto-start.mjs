#!/usr/bin/env node
// Optional VS Code/Codespaces startup entrypoint for the owner-private,
// subscription-backed Grok review dispatcher. Never invokes Grok on its own:
// the dispatcher requires a trusted, SHA-exact owner lease before model use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'NTinkicht/Tabibi';
const PAID_KEYS = [
  'XAI_API_KEY',
  'XAI_BASE_URL',
  'GROK_API_KEY',
  'OPENROUTER_API_KEY',
];

export function startupDecision(
  env,
  {
    branch,
    clean,
    authAvailable,
    hasNode = true,
    hasGrok = true,
    hasGh = true,
  } = {},
) {
  if (
    env.CODESPACES !== 'true' ||
    env.GITHUB_REPOSITORY !== REPO ||
    env.GITHUB_USER !== 'NTinkicht' ||
    env.GITHUB_ACTIONS
  )
    return 'OWNER_CODESPACE_REQUIRED';
  if (PAID_KEYS.some((key) => Boolean(env[key])))
    return 'METERED_ENVIRONMENT_FORBIDDEN';
  if (branch !== 'main') return 'MAIN_BRANCH_REQUIRED';
  if (!clean) return 'UNCOMMITTED_CHANGES';
  if (!authAvailable) return 'PRIVATE_GROK_LOGIN_REQUIRED';
  if (!hasNode || !hasGrok || !hasGh) return 'LOCAL_CLI_UNAVAILABLE';
  return 'ELIGIBLE';
}

function safeCommand(bin, args, timeout = 30_000) {
  const result = spawnSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    timeout,
    maxBuffer: 64 * 1024,
  });
  // Provider, authentication and git stderr are never printed.
  return result.error || result.status !== 0 ? null : result.stdout.trim();
}

async function main() {
  const env = process.env;
  // Fail closed without even inspecting credentials outside the owner Codespace.
  if (
    env.CODESPACES !== 'true' ||
    env.GITHUB_REPOSITORY !== REPO ||
    env.GITHUB_USER !== 'NTinkicht' ||
    env.GITHUB_ACTIONS
  ) {
    process.stdout.write(
      'SaveGrok: owner Codespace required; no process started.\n',
    );
    return;
  }
  const branch = safeCommand('git', ['branch', '--show-current']);
  const clean =
    safeCommand('git', ['diff', '--quiet']) !== null &&
    safeCommand('git', ['diff', '--cached', '--quiet']) !== null;
  const grokHome = env.GROK_HOME || path.join(os.homedir(), '.grok');
  // VS Code process tasks may not source the owner's interactive shell PATH.
  // The official installer places the CLI in ~/.grok/bin by default.
  env.PATH = [
    path.join(os.homedir(), '.grok', 'bin'),
    path.join(grokHome, 'bin'),
    env.PATH || '',
  ].join(path.delimiter);
  const authAvailable = fs.existsSync(path.join(grokHome, 'auth.json'));
  const decision = startupDecision(env, {
    branch,
    clean,
    authAvailable,
    hasNode: Number(process.versions.node.split('.')[0]) >= 20,
    hasGrok: safeCommand('grok', ['version']) !== null,
    hasGh: safeCommand('gh', ['auth', 'status']) !== null,
  });
  if (decision !== 'ELIGIBLE') {
    process.stdout.write(
      `SaveGrok: ${decision}; no model call or worker started.\n`,
    );
    return;
  }
  // A fresh Codespace often has stale local main. Update ONLY clean main,
  // fast-forward ONLY; no reset, rebase, commit, force push or branch switch.
  if (
    safeCommand('git', ['pull', '--ff-only', 'origin', 'main'], 60_000) === null
  ) {
    process.stdout.write(
      'SaveGrok: MAIN_FAST_FORWARD_UNAVAILABLE; no worker started.\n',
    );
    return;
  }
  process.stdout.write(
    'SaveGrok: GitHub/CI lease watcher active in owner Codespace. ' +
      'No Grok call unless an eligible review lease exists; stop this task to stop.\n',
  );
  const worker = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts', 'grok-dispatcher.mjs'), '--watch'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env,
    },
  );
  const forward = (signal) => {
    if (!worker.killed) worker.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  worker.on('error', () => {
    process.stderr.write('SaveGrok: worker could not start.\n');
    process.exitCode = 1;
  });
  worker.on('exit', (code) => {
    process.exitCode = code || 0;
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    // No stack traces, environment contents, auth details or raw git/CLI errors.
    process.stderr.write('SaveGrok: STARTUP_FAILED; no worker started.\n');
    process.exitCode = 1;
  });
}
