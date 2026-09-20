import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// The owner Codespace launcher deliberately runs as plain Node ESM.
// @ts-expect-error The runtime .mjs file intentionally has no generated types.
import * as launcher from '../../scripts/grok-auto-start.mjs';

const { isExactFetchedMain, startupDecision } = launcher;

const ownerEnv = {
  CODESPACES: 'true',
  GITHUB_REPOSITORY: 'NTinkicht/Tabibi',
  GITHUB_USER: 'NTinkicht',
};
const ready = {
  branch: 'main',
  clean: true,
  authAvailable: true,
};
const decide = (
  env: Record<string, string | undefined> = ownerEnv,
  options: Record<string, string | boolean> = ready,
) => startupDecision(env, options);

describe('SaveGrok automatic owner-Codespace startup', () => {
  it('allows only explicitly eligible private owner sessions with a clean main', () => {
    expect(decide()).toBe('ELIGIBLE');
    expect(decide({ ...ownerEnv, GITHUB_USER: 'stranger' })).toBe(
      'OWNER_CODESPACE_REQUIRED',
    );
    expect(decide({ ...ownerEnv, GITHUB_REPOSITORY: 'other/repo' })).toBe(
      'OWNER_CODESPACE_REQUIRED',
    );
    expect(decide({ ...ownerEnv, CODESPACES: 'false' })).toBe(
      'OWNER_CODESPACE_REQUIRED',
    );
    expect(decide({ ...ownerEnv, GITHUB_ACTIONS: 'true' })).toBe(
      'OWNER_CODESPACE_REQUIRED',
    );
  });

  it('refuses every known paid provider environment and missing private OAuth', () => {
    for (const key of [
      'XAI_API_KEY',
      'XAI_BASE_URL',
      'GROK_API_KEY',
      'OPENROUTER_API_KEY',
    ]) {
      expect(decide({ ...ownerEnv, [key]: 'present' })).toBe(
        'METERED_ENVIRONMENT_FORBIDDEN',
      );
    }
    expect(decide(ownerEnv, { ...ready, authAvailable: false })).toBe(
      'PRIVATE_GROK_LOGIN_REQUIRED',
    );
  });

  it('refuses branch switching, dirty main and unavailable local CLIs', () => {
    expect(decide(ownerEnv, { ...ready, branch: 'feature' })).toBe(
      'MAIN_BRANCH_REQUIRED',
    );
    expect(decide(ownerEnv, { ...ready, clean: false })).toBe(
      'UNCOMMITTED_CHANGES',
    );
    for (const key of ['hasNode', 'hasGrok', 'hasGh']) {
      expect(decide(ownerEnv, { ...ready, [key]: false })).toBe(
        'LOCAL_CLI_UNAVAILABLE',
      );
    }
  });

  it('rejects locally ahead or stale main even when pull --ff-only exits successfully', () => {
    const remote = 'a'.repeat(40);
    expect(isExactFetchedMain(remote, remote)).toBe(true);
    expect(isExactFetchedMain('b'.repeat(40), remote)).toBe(false);
    expect(isExactFetchedMain(null, remote)).toBe(false);
    expect(isExactFetchedMain(remote, null)).toBe(false);
  });

  it('defines a visible opt-in editor task, never an unconditional GitHub-hosted Grok Action', () => {
    const tasks = JSON.parse(
      fs.readFileSync(path.resolve('.vscode/tasks.json'), 'utf8'),
    ) as {
      tasks: Array<{
        command: string;
        args: string[];
        runOptions: { runOn: string; instanceLimit: number };
        presentation: { reveal: string };
      }>;
    };
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0].command).toBe('node');
    expect(tasks.tasks[0].args).toEqual(['scripts/grok-auto-start.mjs']);
    expect(tasks.tasks[0].runOptions).toMatchObject({
      runOn: 'folderOpen',
      instanceLimit: 1,
    });
    expect(tasks.tasks[0].presentation.reveal).toBe('always');
  });
});
