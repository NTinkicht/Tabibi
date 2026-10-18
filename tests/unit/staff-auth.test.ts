import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatedClinicScope,
  createStaffSessionToken,
  requireSameOrigin,
  StaffAuthenticationError,
  StaffCsrfError,
} from '@/platform/http/staff-auth';

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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('signed staff session token structure', () => {
  const clinicId = '00000000-0000-4000-8000-000000000001';

  function staffRequest(token: string): Request {
    return new Request('http://localhost:3000/api/clinics/example/sessions', {
      headers: { cookie: `tabibi_staff_session=${token}` },
    });
  }

  it('rejects extra signed-token components before any staff lookup', async () => {
    vi.stubEnv(
      'STAFF_SESSION_SECRET',
      'staff-auth-unit-test-only-signing-secret-0123456789',
    );
    const token = createStaffSessionToken(
      'synthetic-staff-subject',
      new Date(Date.now() + 60_000),
    );
    expect(token.split('.')).toHaveLength(2);
    for (const malformed of [
      `${token}.untrusted`,
      `${token}.`,
      `${token}..`,
      `prefix.${token}`,
    ]) {
      await expect(
        authenticatedClinicScope(staffRequest(malformed), clinicId),
      ).rejects.toBeInstanceOf(StaffAuthenticationError);
    }
  });

  it('rejects missing signature pieces and a tampered signature', async () => {
    vi.stubEnv(
      'STAFF_SESSION_SECRET',
      'staff-auth-unit-test-only-signing-secret-0123456789',
    );
    const token = createStaffSessionToken(
      'synthetic-staff-subject',
      new Date(Date.now() + 60_000),
    );
    const [payload, signature] = token.split('.');
    expect(payload).toBeTruthy();
    expect(signature).toBeTruthy();
    if (!payload || !signature) throw new Error('invalid test fixture');
    const alternate = signature.endsWith('A') ? 'B' : 'A';
    for (const malformed of [
      payload,
      `${payload}.`,
      `.${signature}`,
      `${payload}.${signature.slice(0, -1)}${alternate}`,
    ]) {
      await expect(
        authenticatedClinicScope(staffRequest(malformed), clinicId),
      ).rejects.toBeInstanceOf(StaffAuthenticationError);
    }
  });
});
