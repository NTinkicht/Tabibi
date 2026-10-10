import { describe, expect, it } from 'vitest';
import { migrationConnectionString } from '@/platform/config/migration-credentials';

const runtime = 'postgresql://tabibi_runtime:runtime@localhost:5432/tabibi';
const owner = 'postgresql://tabibi_owner:owner@localhost:5432/tabibi';

describe('production migration credential separation', () => {
  it('continues existing local and CI migration connections', () => {
    expect(
      migrationConnectionString({
        NODE_ENV: 'test',
        DATABASE_URL: runtime,
      }),
    ).toBe(runtime);
    expect(
      migrationConnectionString({
        NODE_ENV: 'development',
        DATABASE_URL: runtime,
        MIGRATION_DATABASE_URL: owner,
      }),
    ).toBe(owner);
  });

  it('requires an explicit distinct production migration login', () => {
    expect(() =>
      migrationConnectionString({
        NODE_ENV: 'production',
        DATABASE_URL: runtime,
      }),
    ).toThrow(/MIGRATION_DATABASE_URL/);
    expect(() =>
      migrationConnectionString({
        NODE_ENV: 'production',
        DATABASE_URL: runtime,
        MIGRATION_DATABASE_URL: runtime,
      }),
    ).toThrow(/distinct PostgreSQL roles/);
    expect(() =>
      migrationConnectionString({
        NODE_ENV: 'production',
        DATABASE_URL: runtime,
        MIGRATION_DATABASE_URL: 'not-a-url',
      }),
    ).toThrow();
    expect(
      migrationConnectionString({
        NODE_ENV: 'production',
        DATABASE_URL: runtime,
        MIGRATION_DATABASE_URL: owner,
      }),
    ).toBe(owner);
  });
});
