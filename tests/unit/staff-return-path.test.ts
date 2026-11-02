import { describe, expect, it } from 'vitest';
import { safeReturnPath } from '@/app/staff/sign-in/return-path';

describe('safeReturnPath', () => {
  it('accepts same-origin staff paths', () => {
    expect(safeReturnPath('/operations/abc')).toBe('/operations/abc');
    expect(safeReturnPath('/operations/abc/notifications?locale=fr')).toBe(
      '/operations/abc/notifications?locale=fr',
    );
  });
  it.each([
    'https://evil.example/operations/x',
    '//evil.example/operations/x',
    '/\\evil.example',
    '/operations/\\..\\x',
    '/%2f%2fevil.example',
    '/operations/%2e%2e/%2e%2e/guest',
    '/operations/../guest',
    '/operations/x\r\nset-cookie:a=b',
    '/operations/%0d%0a',
    '/operations/x://y',
    '/guest/status',
    'operations/x',
    '',
    '/operations/%',
  ])('rejects %j', (value) => {
    expect(safeReturnPath(value)).toBeNull();
  });
  it('rejects non-strings and oversized values', () => {
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath(['/operations/a'])).toBeNull();
    expect(safeReturnPath(`/operations/${'a'.repeat(600)}`)).toBeNull();
  });
});
