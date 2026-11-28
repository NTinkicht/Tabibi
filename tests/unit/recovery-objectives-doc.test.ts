import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const DOC = 'docs/release/recovery-objectives-and-launch-readiness.md';

/** Repo-relative paths cited in backticks that this document must keep valid. */
export function citedPaths(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/`((?:src|tests|docs)\/[^`\s]+)`/g)) {
    found.add(match[1]);
  }
  return [...found];
}

/** npm scripts cited as `npm run <name>`. */
export function citedScripts(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
    found.add(match[1]);
  }
  return [...found];
}

function missingPaths(paths: string[]): string[] {
  return paths.filter((path) => !existsSync(join(ROOT, path)));
}

function missingScripts(scripts: string[], known: string[]): string[] {
  return scripts.filter((name) => !known.includes(name));
}

describe('recovery objectives and launch readiness document', () => {
  const markdown = readFileSync(join(ROOT, DOC), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const known = Object.keys(pkg.scripts);

  it('cites repository files and routes that exist', () => {
    const paths = citedPaths(markdown);
    expect(paths.length).toBeGreaterThan(8);
    expect(missingPaths(paths)).toEqual([]);
  });

  it('cites only npm scripts that exist', () => {
    const scripts = citedScripts(markdown);
    expect(scripts).toEqual(
      expect.arrayContaining([
        'db:rehearse-recovery',
        'db:clinic-day-load',
        'worker:notifications',
      ]),
    );
    expect(missingScripts(scripts, known)).toEqual([]);
  });

  it('detects a missing path and a missing script (positive control)', () => {
    const doctored =
      markdown +
      '\n`tests/unit/does-not-exist.test.ts`\nnpm run no-such-script\n';
    expect(missingPaths(citedPaths(doctored))).toEqual([
      'tests/unit/does-not-exist.test.ts',
    ]);
    expect(missingScripts(citedScripts(doctored), known)).toEqual([
      'no-such-script',
    ]);
  });

  it('defines an RPO and RTO for every failure class', () => {
    const rows = markdown
      .split('\n')
      .filter((line) =>
        /^\| (Web process|Notification worker|Database|Full host)/.test(line),
      );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      expect(cells[2]).toMatch(/^\d/);
      expect(cells[3]).toMatch(/\d+ (minutes|hours)/);
    }
  });

  it('keeps the proposed and not-a-certification wording', () => {
    expect(markdown).toMatch(/not a certification/);
    expect(markdown).toMatch(/PROPOSED/);
    expect(markdown).toMatch(/non-production target with synthetic data only/);
  });

  it('keeps the readiness checklist unchecked (no pre-ticked evidence)', () => {
    expect(markdown).not.toMatch(/- \[x\]/i);
    expect(markdown.match(/- \[ \]/g)?.length).toBeGreaterThanOrEqual(10);
  });
});
