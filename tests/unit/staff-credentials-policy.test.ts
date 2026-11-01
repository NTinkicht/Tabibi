import { describe, expect, it } from 'vitest';
import {
  PasswordPolicyError,
  validatePasswordPolicy,
} from '@/modules/identity/staff-credentials';

describe('staff password policy (#723)', () => {
  const subject = 'nadia.benali@clinic.example';
  const code = (password: string): string | null => {
    try {
      validatePasswordPolicy(password, subject);
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(PasswordPolicyError);
      return (error as PasswordPolicyError).code;
    }
  };

  it('accepts 12 or more characters', () => {
    expect(code('correct-horse-9')).toBeNull();
    expect(code('abcdefghijkl')).toBeNull();
  });

  it('rejects short and oversized passwords', () => {
    expect(code('abcdefghijk')).toBe('too_short');
    expect(code('x'.repeat(257))).toBe('too_long');
  });

  it('rejects the email or its local part regardless of case', () => {
    expect(code('Nadia.Benali@Clinic.Example')).toBe('matches_identity');
    expect(code('NADIA.BENALI@clinic.example')).toBe('matches_identity');
    expect(
      (() => {
        try {
          validatePasswordPolicy('benalinadia-x', 'benalinadia-x');
          return null;
        } catch (e) {
          return (e as PasswordPolicyError).code;
        }
      })(),
    ).toBe('matches_identity');
  });

  it('never echoes the password in the error', () => {
    const secret = 'short-pw';
    try {
      validatePasswordPolicy(secret, subject);
      throw new Error('expected rejection');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('compares identities after Unicode normalization on both sides', () => {
    const decomposed = 'me\u0301decin@clinic.example';
    expect(() => validatePasswordPolicy(decomposed, decomposed)).toThrowError(
      PasswordPolicyError,
    );
    expect(() =>
      validatePasswordPolicy('m\u00e9decin@clinic.example', decomposed),
    ).toThrowError(PasswordPolicyError);
  });
});
