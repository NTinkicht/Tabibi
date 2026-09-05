import { describe, expect, it } from 'vitest';
import { getEnvironment } from '@/platform/config/env';

describe('environment validation', () => {
  it('accepts an explicit valid environment', () => {
    expect(
      getEnvironment({
        DATABASE_URL: 'postgresql://localhost/tabibi',
        NODE_ENV: 'test',
      }).NODE_ENV,
    ).toBe('test');
  });
  it('fails fast when the database URL is absent', () => {
    expect(() => getEnvironment({ NODE_ENV: 'test' })).toThrow(
      'Invalid environment configuration',
    );
  });
  it('rejects non-PostgreSQL URLs', () => {
    expect(() =>
      getEnvironment({ DATABASE_URL: 'https://example.test/db' }),
    ).toThrow('Invalid environment configuration');
  });
});
