import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

const targets = [
  'src/modules/appointment/recovery.ts',
  'tests/integration/appointment-recovery.test.ts',
];

describe('temporary prettier diagnostic', () => {
  it('prints exact formatter deltas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabibi-prettier-'));
    for (const target of targets) {
      const formatted = execFileSync('npx', ['prettier', target], {
        encoding: 'utf8',
      });
      const copy = join(dir, target.replaceAll('/', '__'));
      writeFileSync(copy, formatted);
      try {
        execFileSync('diff', ['-u', target, copy], { encoding: 'utf8' });
      } catch (error) {
        const output = (error as { stdout?: string }).stdout ?? '';
        console.log(`PRETTIER_DIFF_START ${target}\n${output}\nPRETTIER_DIFF_END ${target}`);
      }
      readFileSync(copy, 'utf8');
    }
  });
});
