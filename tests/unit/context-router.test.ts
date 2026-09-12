import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const ROUTER = path.join(ROOT, 'scripts', 'context-router.mjs');
let scratch: string;
let externalDirs: string[] = [];
type EnvOverrides = Record<string, string | undefined>;

function relative(file: string) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function baseEnv(extra: EnvOverrides = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TABIBI_CONTEXT_TEST_MODE: '1',
    TABIBI_CONTEXT_STATE_DIR: path.join(scratch, 'state'),
    ...extra,
    NODE_ENV: process.env.NODE_ENV,
  };
}

function runRouter(args: string[], env: EnvOverrides = {}) {
  return spawnSync(process.execPath, [ROUTER, ...args], {
    cwd: ROOT,
    env: baseEnv(env),
    encoding: 'utf8',
  });
}

function runRouterAsync(args: string[], env: EnvOverrides = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [ROUTER, ...args], {
        cwd: ROOT,
        env: baseEnv(env),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', rejectPromise);
      child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    },
  );
}

function writeBudget(remainingUnits: number) {
  const stateDir = path.join(scratch, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'context-budget.json'),
    `${JSON.stringify({ remainingUnits, hardStop: false }, null, 2)}\n`,
  );
}

function makeFakeCopilot(body: string) {
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'copilot');
  fs.writeFileSync(executable, `#!/usr/bin/env sh\nset -eu\n${body}\n`);
  fs.chmodSync(executable, 0o755);
  return bin;
}

beforeEach(() => {
  scratch = path.join(
    ROOT,
    'tests',
    `.tmp-context-router-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(scratch, { recursive: true });
  externalDirs = [];
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const directory of externalDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('context router safety', () => {
  it('rejects an in-repository symlink whose resolved target is outside the repository', () => {
    if (process.platform === 'win32') return;
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'tabibi-router-'));
    externalDirs.push(external);
    const secret = path.join(external, 'external-secret.txt');
    fs.writeFileSync(secret, 'must-not-be-read');
    const link = path.join(scratch, 'safe-name.txt');
    fs.symlinkSync(secret, link);

    const result = runRouter(['profile', relative(link)]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Resolved target');
    expect(result.stderr).toContain('must stay inside the repository');
    expect(result.stdout).not.toContain('must-not-be-read');
  });

  it.each(['patient-record.json', 'provider-payload.json'])(
    'rejects documented sensitive data class %s before reading it',
    (name) => {
      const file = path.join(scratch, name);
      fs.writeFileSync(file, 'sensitive');

      const result = runRouter(['profile', relative(file)]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Sensitive path is not eligible');
    },
  );

  it('allows only one concurrent process to consume the final Copilot unit', async () => {
    if (process.platform === 'win32') return;
    const source = path.join(scratch, 'safe-source.txt');
    fs.writeFileSync(source, 'bounded evidence');
    writeBudget(1);
    const count = path.join(scratch, 'copilot-count.txt');
    const bin = makeFakeCopilot(
      'printf "1\\n" >> "$TABIBI_FAKE_COPILOT_COUNT"\nsleep 0.4\nprintf "compressed\\n"',
    );
    const env = {
      TABIBI_CONTEXT_ALLOW_COPILOT: '1',
      TABIBI_FAKE_COPILOT_COUNT: count,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    };
    const args = ['compress', 'summarize', '--', relative(source)];

    const results = await Promise.all([
      runRouterAsync(args, env),
      runRouterAsync(args, env),
    ]);

    expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
    expect(fs.readFileSync(count, 'utf8').trim().split(/\r?\n/)).toHaveLength(
      1,
    );
    const budget = JSON.parse(
      fs.readFileSync(
        path.join(scratch, 'state', 'context-budget.json'),
        'utf8',
      ),
    );
    expect(budget.remainingUnits).toBe(0);
    expect(
      fs.existsSync(path.join(scratch, 'state', 'context-budget.lock')),
    ).toBe(false);
  });

  it('refunds an ordinary failed Copilot invocation while keeping crash recovery fail-closed', () => {
    if (process.platform === 'win32') return;
    const source = path.join(scratch, 'safe-source.txt');
    fs.writeFileSync(source, 'bounded evidence');
    writeBudget(1);
    const bin = makeFakeCopilot('echo "simulated failure" >&2\nexit 7');

    const result = runRouter(
      ['compress', 'summarize', '--', relative(source)],
      {
        TABIBI_CONTEXT_ALLOW_COPILOT: '1',
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    );

    expect(result.status).toBe(2);
    const budget = JSON.parse(
      fs.readFileSync(
        path.join(scratch, 'state', 'context-budget.json'),
        'utf8',
      ),
    );
    expect(budget.remainingUnits).toBe(1);
    expect(
      fs.existsSync(path.join(scratch, 'state', 'context-budget.lock')),
    ).toBe(false);
  });
});
