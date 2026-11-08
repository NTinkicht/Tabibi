import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/styles.css'), 'utf8');
const doctorView = readFileSync(
  join(
    process.cwd(),
    'src/app/operations/[clinicId]/sessions/[sessionId]/doctor/doctor-view.tsx',
  ),
  'utf8',
);

describe('doctor take-next styling', () => {
  it.each(['priorityBadge', 'takeNextPanel', 'takeNext'])(
    'defines the .%s class that the doctor view renders',
    (name) => {
      expect(doctorView).toContain(name);
      expect(css).toMatch(new RegExp(`^\\.${name}\\s*\\{`, 'm'));
    },
  );
});
