import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const DOC = 'docs/release/monitoring-and-alerting.md';

const REPO_PATH = /`((?:src|tests|docs|scripts)\/[^`\s]+)`/g;
const NPM_SCRIPT = /npm run ([a-z:-]+)/g;

export function citedPaths(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(REPO_PATH)].map((m) => m[1]))];
}

export function citedNpmScripts(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(NPM_SCRIPT)].map((m) => m[1]))];
}

function missingPaths(markdown: string): string[] {
  return citedPaths(markdown).filter((p) => !existsSync(join(ROOT, p)));
}

function missingScripts(markdown: string): string[] {
  const scripts = (
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  return citedNpmScripts(markdown).filter((s) => !(s in scripts));
}

interface SignalRow {
  signal: string;
  source: string;
}

/** Rows of the "Signal inventory" table: first-column signal, cited source. */
export function signalRows(markdown: string): SignalRow[] {
  const section = markdown.split('## Signal inventory')[1]?.split('\n## ')[0];
  if (!section) return [];
  const rows: SignalRow[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || line.startsWith('|---')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const signal = /`([^`]+)`/.exec(cells[1] ?? '')?.[1];
    const source = /`((?:src|scripts)\/[^`\s]+)`/.exec(cells[2] ?? '')?.[1];
    if (signal && source) rows.push({ signal, source });
  }
  return rows;
}

/** Signals whose emitting source no longer mentions them. */
function driftedSignals(markdown: string): string[] {
  return signalRows(markdown)
    .filter(({ signal, source }) => {
      const path = join(ROOT, source);
      if (!existsSync(path)) return true;
      const route = /^GET \/(api\/\S+)$/.exec(signal)?.[1];
      if (route) return !source.includes(`${route}/route.ts`);
      return !readFileSync(path, 'utf8').includes(signal);
    })
    .map(({ signal }) => signal);
}

describe('monitoring and alerting guide', () => {
  const markdown = readFileSync(join(ROOT, DOC), 'utf8');

  it('documents every operator signal the code emits', () => {
    const signals = signalRows(markdown).map((r) => r.signal);
    expect(signals).toEqual(
      expect.arrayContaining([
        'GET /api/health',
        'GET /api/ready',
        'request completed',
        'request failed',
        'x-request-id',
        'notification.worker.tick',
        'notification.worker.tick_failed',
        'notification.worker.fatal',
        'retention.sweep',
        'retention.sweep.fatal',
      ]),
    );
  });

  it('only cites repository paths and npm scripts that exist', () => {
    expect(citedPaths(markdown).length).toBeGreaterThan(8);
    expect(missingPaths(markdown)).toEqual([]);
    expect(missingScripts(markdown)).toEqual([]);
  });

  it('keeps every documented signal present in its emitting source', () => {
    expect(driftedSignals(markdown)).toEqual([]);
  });

  it('detects a renamed log event, a bad path and a bad script (positive controls)', () => {
    const renamed = markdown.replace(
      '| `retention.sweep.fatal` |',
      '| `retention.sweep.renamed` |',
    );
    expect(driftedSignals(renamed)).toEqual(['retention.sweep.renamed']);
    expect(missingPaths(`${markdown}\n\`docs/release/nope.md\`\n`)).toEqual([
      'docs/release/nope.md',
    ]);
    expect(missingScripts(`${markdown}\nnpm run not-a-script\n`)).toEqual([
      'not-a-script',
    ]);
  });

  it('keeps the proposed-not-certified and privacy wording', () => {
    expect(markdown).toMatch(/PROPOSED/);
    expect(markdown).toMatch(/not a certification/);
    expect(markdown).toMatch(/Never add patient names/);
    expect(markdown).toMatch(/Proposed alert rules \(PROPOSED\)/);
  });
});
