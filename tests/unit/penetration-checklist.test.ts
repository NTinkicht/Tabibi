import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const CHECKLIST = 'docs/release/penetration-checklist.md';

/** Repo-relative paths cited in backticks that this document must keep valid. */
export function citedPaths(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/`((?:src|tests|docs)\/[^`\s]+)`/g)) {
    found.add(match[1]);
  }
  return [...found].filter((path) => !path.includes('**'));
}

function missing(paths: string[]): string[] {
  return paths.filter((path) => !existsSync(join(ROOT, path)));
}

describe('penetration checklist', () => {
  const markdown = readFileSync(join(ROOT, CHECKLIST), 'utf8');
  const paths = citedPaths(markdown);

  it('cites a non-trivial set of routes and tests', () => {
    expect(
      paths.filter((p) => p.startsWith('src/app/api/')).length,
    ).toBeGreaterThan(8);
    expect(paths.filter((p) => p.startsWith('tests/')).length).toBeGreaterThan(
      8,
    );
  });

  it('only cites paths that exist in the repository', () => {
    expect(missing(paths)).toEqual([]);
  });

  it('detects a missing path (positive control)', () => {
    const doctored =
      markdown + '\n`tests/integration/does-not-exist.test.ts`\n';
    expect(missing(citedPaths(doctored))).toEqual([
      'tests/integration/does-not-exist.test.ts',
    ]);
  });

  it('keeps the production-target warning', () => {
    expect(markdown).toMatch(/Never point it at production/);
  });
});
