import { describe, expect, it, vi } from 'vitest';
import { AuthorizationError, type Queryable } from '@/modules/identity';
import { authenticatedClinicScope } from '@/platform/http/staff-auth';

const request = (subject?: string) =>
  new Request('http://localhost/api', {
    headers: subject ? { 'x-auth-subject': subject } : {},
  });

describe('staff API authentication boundary', () => {
  it('maps an authenticated subject to an internal actor and explicit clinic scope', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ id: 'user-1' }], rowCount: 1 }),
    } as unknown as Queryable;
    await expect(
      authenticatedClinicScope(db, request('subject-1'), 'clinic-1'),
    ).resolves.toEqual({
      actorUserId: 'user-1',
      clinicId: 'clinic-1',
    });
    expect(db.query).toHaveBeenCalledWith(
      'SELECT id FROM users WHERE auth_subject = $1',
      ['subject-1'],
    );
  });

  it.each([undefined, 'unknown'])(
    'rejects missing or unknown authentication (%s)',
    async (subject) => {
      const db = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      } as unknown as Queryable;
      await expect(
        authenticatedClinicScope(db, request(subject), 'clinic-1'),
      ).rejects.toBeInstanceOf(AuthorizationError);
    },
  );
});
