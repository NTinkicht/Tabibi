import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const dockerignore = readFileSync('.dockerignore', 'utf8');
const lines = dockerfile
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const SECRET_NAME =
  /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|DATABASE_URL)/i;

function declaredEnvAndArgs(): Array<{ name: string; value: string | null }> {
  const out: Array<{ name: string; value: string | null }> = [];
  const joined = dockerfile.replace(/\\\n/g, ' ');
  for (const raw of joined.split('\n')) {
    const line = raw.trim();
    const match = /^(ENV|ARG)\s+(.*)$/.exec(line);
    if (!match) continue;
    const rest = match[2]!;
    if (match[1] === 'ARG' || !rest.includes('=')) {
      const [name, ...v] = rest.split('=');
      out.push({ name: name!.trim(), value: v.length ? v.join('=') : null });
      continue;
    }
    for (const pair of rest.match(/[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\S*)/g) ??
      []) {
      const idx = pair.indexOf('=');
      out.push({ name: pair.slice(0, idx), value: pair.slice(idx + 1) });
    }
  }
  return out;
}

describe('production container image definition', () => {
  it('is a multi-stage build from npm ci on the .nvmrc Node major', () => {
    const major = readFileSync('.nvmrc', 'utf8')
      .trim()
      .replace(/^v/, '')
      .split('.')[0];
    const froms = lines.filter((l) => l.startsWith('FROM '));
    expect(froms.length).toBeGreaterThanOrEqual(3);
    for (const from of froms) expect(from).toContain(`node:${major}-`);
    expect(dockerfile).toMatch(/RUN npm ci/);
    expect(dockerfile).toMatch(/RUN npm run build/);
  });

  it('runs the final stage as the non-root node user', () => {
    const finalStart = dockerfile.lastIndexOf('FROM ');
    const finalStage = dockerfile.slice(finalStart);
    expect(finalStage).toMatch(/^USER node$/m);
    expect(finalStage).not.toMatch(/^USER (root|0)\b/m);
    expect(dockerfile.indexOf('USER node')).toBeGreaterThan(finalStart);
  });

  it('declares a readiness HEALTHCHECK and bounds the Node heap via an env var', () => {
    expect(dockerfile).toMatch(/^HEALTHCHECK .*\\?[\s\S]*\/api\/ready/m);
    expect(dockerfile).not.toMatch(/HEALTHCHECK[\s\S]*\/api\/health['"\s]/);
    expect(dockerfile).toMatch(/NODE_HEAP_MB=\d+/);
    expect(dockerfile).toMatch(/--max-old-space-size=\$\{NODE_HEAP_MB\}/);
  });

  it('never sets a value on a secret-looking ENV or ARG', () => {
    const declared = declaredEnvAndArgs();
    expect(declared.length).toBeGreaterThan(0);
    for (const { name, value } of declared) {
      if (SECRET_NAME.test(name)) {
        expect(value === null || value === '').toBe(true);
      }
    }
  });

  it('only copies explicit application paths, never env files or fixtures', () => {
    const copies = lines.filter((l) => l.startsWith('COPY '));
    for (const copy of copies) {
      expect(copy).not.toMatch(/\.env/);
      expect(copy).not.toMatch(/\btests?\b/);
      expect(copy).not.toMatch(/COPY (--\S+ )*\. /);
    }
  });

  it('excludes env files, tests and git metadata from the build context', () => {
    const entries = dockerignore.split('\n').map((l) => l.trim());
    for (const required of [
      '.git',
      '.env',
      '.env.*',
      'node_modules',
      'tests',
    ]) {
      expect(entries).toContain(required);
    }
  });

  it('documents every required runtime variable by name only', () => {
    const doc = readFileSync('docs/deploy/container.md', 'utf8');
    for (const name of [
      'DATABASE_URL',
      'STAFF_SESSION_SECRET',
      'GUEST_BEARER_SIGNING_SECRET',
      'PUBLIC_AVAILABILITY_SELECTION_SECRET',
      'NODE_HEAP_MB',
    ]) {
      expect(doc).toContain(`\`${name}\``);
    }
    expect(doc).not.toMatch(/(SECRET|DATABASE_URL)\w*=\S+/);
    expect(doc).toContain('db:migrate');
  });
});
