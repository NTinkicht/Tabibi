import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const router = path.join(process.cwd(), 'scripts', 'actor-router.mjs');
const registryPath = path.join(
  process.cwd(),
  'coordination',
  'ACTOR_REGISTRY.json',
);

function route(capability: string, ...flags: string[]) {
  return JSON.parse(
    execFileSync(process.execPath, [router, capability, ...flags], {
      encoding: 'utf8',
    }),
  );
}

describe('six-actor capacity routing', () => {
  it('prefers Codex for implementation', () => {
    expect(route('implementation').selected).toBe('codex');
  });

  it('routes repository intelligence and regression scouting to Gemini CLI', () => {
    expect(route('repository_intelligence').selected).toBe('gemini-cli');
    expect(route('regression_scouting').selected).toBe('gemini-cli');
  });

  it('routes failure analysis and test design to Mistral Vibe', () => {
    expect(route('failure_analysis').selected).toBe('mistral-vibe');
    expect(route('test_design').selected).toBe('mistral-vibe');
  });

  it('preserves reviewer independence and can fail over to Gemini CLI', () => {
    const result = route('review', '--authors=claude,chatgpt,codex');
    expect(result.selected).toBe('gemini-cli');
    expect(
      result.considered.filter(
        (entry: { eligible: boolean }) => !entry.eligible,
      ),
    ).toHaveLength(3);
  });

  it('can fail over from Gemini CLI to Mistral Vibe for review', () => {
    const result = route(
      'review',
      '--authors=claude,chatgpt,codex',
      '--unavailable=gemini-cli',
    );
    expect(result.selected).toBe('mistral-vibe');
  });

  it('fails closed when every review candidate is a material author', () => {
    const result = spawnSync(
      process.execPath,
      [
        router,
        'review',
        '--authors=claude,chatgpt,codex,gemini-cli,mistral-vibe,copilot',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).selected).toBeNull();
  });

  it('keeps retired Gemini identities out of active routes and forbids paid fallback', () => {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const activeIds = registry.actors
      .filter((actor: { active: boolean }) => actor.active)
      .map((actor: { id: string }) => actor.id);
    const routedIds = Object.values(registry.routing).flat() as string[];

    expect(activeIds).toEqual([
      'chatgpt',
      'codex',
      'claude',
      'copilot',
      'gemini-cli',
      'mistral-vibe',
    ]);
    expect(routedIds).not.toContain('gemini_agent');
    expect(routedIds).not.toContain('gemini_chat');
    expect(
      registry.actors.every(
        (actor: { paid_fallback: boolean }) => actor.paid_fallback === false,
      ),
    ).toBe(true);
  });

  it('declares standing roles for Gemini CLI and Mistral Vibe', () => {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const actors = new Map<string, { standing_role?: string }>(
      registry.actors.map((actor: { id: string; standing_role?: string }) => [
        actor.id,
        actor,
      ]),
    );

    expect(actors.get('gemini-cli')?.standing_role).toBe(
      'repository-intelligence-and-regression-scout',
    );
    expect(actors.get('mistral-vibe')?.standing_role).toBe(
      'failure-and-test-design-analyst',
    );
  });

  it('declares every routed capability on every routed actor', () => {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const actors = new Map<string, { capabilities: string[] }>(
      registry.actors.map((actor: { id: string; capabilities: string[] }) => [
        actor.id,
        actor,
      ]),
    );
    const violations: string[] = [];

    for (const [capability, ids] of Object.entries(registry.routing) as [
      string,
      string[],
    ][]) {
      for (const id of ids) {
        if (!actors.get(id)?.capabilities.includes(capability))
          violations.push(`${capability}:${id}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('derives Team Room automation rosters from the actor registry', () => {
    const workflowPaths = [
      'team-heartbeat-watch.yml',
      'team-room-sync.yml',
    ].map((file) => path.join(process.cwd(), '.github', 'workflows', file));

    for (const workflowPath of workflowPaths) {
      const content = fs.readFileSync(workflowPath, 'utf8');
      expect(content).toContain('coordination/ACTOR_REGISTRY.json');
      expect(content).toContain("registry.get('actors', [])");
      expect(content).not.toContain("= {'chatgpt',");
      expect(content).not.toContain('chatgpt|codex|claude|copilot');
    }
  });

  it('relays Gemini CLI and Mistral Vibe in Slack without new credentials', () => {
    const workflowPath = path.join(
      process.cwd(),
      '.github',
      'workflows',
      'slack-team-room-mirror.yml',
    );
    const content = fs.readFileSync(workflowPath, 'utf8');

    expect(content).toContain("'gemini-cli': 'Gemini CLI'");
    expect(content).toContain("'mistral-vibe': 'Mistral Vibe'");
    expect(content).toContain('relayed by the ChatGPT Slack app');
    expect(content).not.toContain('SLACK_GEMINI');
    expect(content).not.toContain('SLACK_MISTRAL');
  });
});
