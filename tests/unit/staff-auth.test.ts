import { describe, expect, it } from 'vitest';
import { requireSameOrigin, StaffCsrfError } from '@/platform/http/staff-auth';

describe('requireSameOrigin', () => {
  it('accepts the canonical request URL origin', () => {
    const request = new Request('http://localhost:3000/api/example', {
      headers: { origin: 'http://localhost:3000' },
    });

    expect(() => requireSameOrigin(request)).not.toThrow();
  });

  it('accepts the received Host when the server runtime canonicalizes the request URL host', () => {
    const request = new Request('http://localhost:3000/api/example', {
      headers: {
        origin: 'http://127.0.0.1:3000',
        host: '127.0.0.1:3000',
      },
    });

    expect(() => requireSameOrigin(request)).not.toThrow();
  });

  it('rejects a cross-site origin even when a Host header is present', () => {
    const request = new Request('http://localhost:3000/api/example', {
      headers: {
        origin: 'http://attacker.example',
        host: '127.0.0.1:3000',
      },
    });

    expect(() => requireSameOrigin(request)).toThrow(StaffCsrfError);
  });

  it('rejects missing, malformed, or wrong-protocol origins', () => {
    const missing = new Request('http://localhost:3000/api/example');
    const malformed = new Request('http://localhost:3000/api/example', {
      headers: { origin: 'not-a-url' },
    });
    const wrongProtocol = new Request('http://localhost:3000/api/example', {
      headers: { origin: 'https://localhost:3000' },
    });

    expect(() => requireSameOrigin(missing)).toThrow(StaffCsrfError);
    expect(() => requireSameOrigin(malformed)).toThrow(StaffCsrfError);
    expect(() => requireSameOrigin(wrongProtocol)).toThrow(StaffCsrfError);
  });
});
