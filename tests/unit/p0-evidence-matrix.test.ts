import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error plain ESM script without type declarations
import { checkMatrix } from '../../scripts/verify-p0-evidence-matrix.mjs';

const root = resolve(__dirname, '../..');
const matrix = readFileSync(
  resolve(root, 'docs/verification/p0-evidence-matrix.md'),
  'utf8',
);

describe('P0 evidence matrix checker', () => {
  it('accepts the committed matrix: every cited path and test title exists', () => {
    expect(checkMatrix(matrix, root)).toEqual([]);
  });

  it('fails when a cited source path does not exist', () => {
    const broken = matrix.replace(
      'src/modules/identity/index.ts',
      'src/modules/identity/does-not-exist.ts',
    );
    expect(
      checkMatrix(broken, root).some((e: string) =>
        e.includes('missing source path'),
      ),
    ).toBe(true);
  });

  it('fails when a cited test title is no longer in the test file', () => {
    const broken = matrix.replace(
      'stores only a SHA-256 verifier of the session identifier',
      'a title that was renamed away',
    );
    expect(
      checkMatrix(broken, root).some((e: string) =>
        e.includes('test title not found'),
      ),
    ).toBe(true);
  });

  it('fails when a row section or its evidence is removed, and rejects COVERED without a test', () => {
    const noRow = matrix.replace('## TAB-P0-07', '## NOT-A-ROW');
    expect(
      checkMatrix(noRow, root).some((e: string) => e.includes('TAB-P0-07')),
    ).toBe(true);
    const noTest = '## TAB-P0-01\n- [COVERED] x | src: package.json\n';
    expect(
      checkMatrix(noTest, root).some((e: string) =>
        e.includes('COVERED needs both'),
      ),
    ).toBe(true);
  });
});
