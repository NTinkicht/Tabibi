import { beforeEach, describe, expect, it, vi } from 'vitest';

type SessionModule = typeof import('@/modules/session');
type StaffAuthModule = typeof import('@/platform/http/staff-auth');

const command = vi.hoisted(() => vi.fn());
const delay = vi.hoisted(() => vi.fn());
const authenticatedClinicScope = vi.hoisted(() => vi.fn());

vi.mock('@/modules/session', async (importOriginal) => {
  const actual = await importOriginal<SessionModule>();
  return {
    ...actual,
    SessionService: class {
      command(...args: unknown[]) {
        return command(...args);
      }
      delay(...args: unknown[]) {
        return delay(...args);
      }
    },
  };
});

vi.mock('@/platform/http/staff-auth', async (importOriginal) => {
  const actual = await importOriginal<StaffAuthModule>();
  return {
    ...actual,
    authenticatedClinicScope,
  };
});

vi.mock('@/platform/database/pool', () => ({ getPool: () => ({}) }));

import { POST as commandPost } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/commands/route';
import { POST as delayPost } from '@/app/api/clinics/[clinicId]/sessions/[sessionId]/delay/route';

const clinicId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';

function request(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { origin: 'http://localhost' },
    body: JSON.stringify(body),
  });
}

function context(clinic: string, session: string) {
  return { params: Promise.resolve({ clinicId: clinic, sessionId: session }) };
}

describe('WU189 staff session operation path validation', () => {
  beforeEach(() => {
    command.mockReset();
    delay.mockReset();
    authenticatedClinicScope.mockReset();
    authenticatedClinicScope.mockResolvedValue({
      clinicId,
      actorUserId: 'actor',
    });
    command.mockResolvedValue({ id: sessionId });
    delay.mockResolvedValue({ id: sessionId });
  });

  it('rejects malformed command route UUIDs before auth or service work', async () => {
    for (const [clinic, session] of [
      ['not-a-uuid', sessionId],
      [clinicId, 'not-a-uuid'],
    ]) {
      const response = await commandPost(
        request(`/api/clinics/${clinic}/sessions/${session}/commands`, {
          command: 'open',
        }),
        context(clinic, session),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid_request');
    }
    expect(authenticatedClinicScope).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it('rejects malformed delay route UUIDs before auth or service work', async () => {
    for (const [clinic, session] of [
      ['not-a-uuid', sessionId],
      [clinicId, 'not-a-uuid'],
    ]) {
      const response = await delayPost(
        request(`/api/clinics/${clinic}/sessions/${session}/delay`, {
          command: 'clear_delay',
          expectedVersion: 0,
        }),
        context(clinic, session),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid_request');
    }
    expect(authenticatedClinicScope).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  it('preserves valid command and delay forwarding', async () => {
    const commandResponse = await commandPost(
      request(`/api/clinics/${clinicId}/sessions/${sessionId}/commands`, {
        command: 'open',
      }),
      context(clinicId, sessionId),
    );
    expect(commandResponse.status).toBe(200);
    expect(command).toHaveBeenCalledTimes(1);

    const delayResponse = await delayPost(
      request(`/api/clinics/${clinicId}/sessions/${sessionId}/delay`, {
        command: 'clear_delay',
        expectedVersion: 0,
      }),
      context(clinicId, sessionId),
    );
    expect(delayResponse.status).toBe(200);
    expect(delay).toHaveBeenCalledTimes(1);
  });
});
