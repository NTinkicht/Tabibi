import { describe, expect, it } from 'vitest';
import {
  assertRecoveryRehearsalAllowed,
  buildRehearsalDatabaseName,
  commandEnvironment,
  databaseUrlForDatabase,
  migrationMetadataMatches,
  parsePostgreSqlTarget,
  pgDumpArgs,
  pgRestoreArgs,
  rowCountsMatch,
} from '../../scripts/db/recovery-rehearsal-lib';

describe('database recovery rehearsal safety helpers', () => {
  it('requires explicit opt-in and refuses production mode', () => {
    expect(() => assertRecoveryRehearsalAllowed({})).toThrow(/disabled/i);
    expect(() =>
      assertRecoveryRehearsalAllowed({
        TABIBI_ALLOW_DB_RECOVERY_REHEARSAL: '1',
        NODE_ENV: 'production',
      }),
    ).toThrow(/production/i);
    expect(() =>
      assertRecoveryRehearsalAllowed({
        TABIBI_ALLOW_DB_RECOVERY_REHEARSAL: '1',
        NODE_ENV: 'test',
      }),
    ).not.toThrow();
  });

  it('keeps database passwords out of command arguments', () => {
    const target = parsePostgreSqlTarget(
      'postgresql://tabibi:s3cret@127.0.0.1:5432/tabibi_test?sslmode=disable',
    );

    expect(target.databaseName).toBe('tabibi_test');
    expect(target.safeDsn).not.toContain('s3cret');
    expect(target.password).toBe('s3cret');
    expect(commandEnvironment({}, target).PGPASSWORD).toBe('s3cret');

    const dumpArgs = pgDumpArgs(target, '/tmp/tabibi.dump');
    const restoreArgs = pgRestoreArgs(target, '/tmp/tabibi.dump');
    expect(dumpArgs.join(' ')).not.toContain('s3cret');
    expect(restoreArgs.join(' ')).not.toContain('s3cret');
    expect(dumpArgs).toContain('--no-owner');
    expect(restoreArgs).toContain('--exit-on-error');
  });

  it('derives a bounded isolated database name and rewrites only the database path', () => {
    const name = buildRehearsalDatabaseName('tabibi-test', 'abc123');
    expect(name).toBe('tabibi_test_rehearsal_abc123');
    expect(name).not.toBe('tabibi-test');
    expect(name.length).toBeLessThanOrEqual(63);

    expect(
      databaseUrlForDatabase(
        'postgresql://user:pass@localhost:5432/tabibi_test?sslmode=disable',
        name,
      ),
    ).toContain(`/tabibi_test_rehearsal_abc123?sslmode=disable`);
  });

  it('compares migration metadata and bounded table counts deterministically', () => {
    const migrations = [
      { name: '0001.sql', checksum: 'a' },
      { name: '0002.sql', checksum: 'b' },
    ];
    expect(migrationMetadataMatches(migrations, [...migrations])).toBe(true);
    expect(
      migrationMetadataMatches(migrations, [
        migrations[0]!,
        { name: '0002.sql', checksum: 'changed' },
      ]),
    ).toBe(false);

    expect(rowCountsMatch({ clinics: '2', users: '4' }, { clinics: '2', users: '4' })).toBe(
      true,
    );
    expect(rowCountsMatch({ clinics: '2' }, { clinics: '3' })).toBe(false);
  });
});
