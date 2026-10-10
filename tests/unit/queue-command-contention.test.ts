import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { QueueConflictError, QueueService } from '@/modules/queue';
import { operationalJson } from '@/platform/http/operational-response';

const scope = {
  clinicId: '11111111-1111-4111-8111-111111111111',
  actorUserId: '22222222-2222-4222-8222-222222222222',
};
const sessionId = '33333333-3333-4333-8333-333333333333';
const entryId = '44444444-4444-4444-8444-444444444444';

function failingCommandPool(code: string) {
  const calls: string[] = [];
  let released = false;
  const client = {
    async query(sql: string) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      throw Object.assign(new Error('PostgreSQL operation contention'), { code });
    },
    release() {
      released = true;
    },
  };
  return {
    pool: {
      async connect() {
        return client;
      },
    } as unknown as Pool,
    calls,
    wasReleased: () => released,
  };
}

function command(pool: Pool) {
  return new QueueService(pool).command(scope, sessionId, entryId, {
    command: 'start_consultation',
    idempotencyKey: 'retry-same-idempotency-key',
    correlationId: 'same-attempt',
  });
}

describe('queue command database contention response', () => {
  for (const code of ['55P03', '40001', '40P01']) {
    it(`maps PostgreSQL ${code} to retryable 409 after rollback`, async () => {
      const fixture = failingCommandPool(code);
      const response = await operationalJson(
        new Request('http://localhost/api/queue'),
        async () => {
          await command(fixture.pool);
          return { status: 200, body: {} };
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'conflict',
        message: expect.stringContaining('same idempotency key'),
      });
      expect(fixture.calls).toEqual([
        'BEGIN',
        expect.stringContaining('pg_advisory_xact_lock'),
        'ROLLBACK',
      ]);
      expect(fixture.wasReleased()).toBe(true);
    });
  }

  it('does not disguise unrelated database errors as retryable conflicts', async () => {
    const fixture = failingCommandPool('42P01');
    await expect(command(fixture.pool)).rejects.not.toBeInstanceOf(
      QueueConflictError,
    );
    expect(fixture.calls.at(-1)).toBe('ROLLBACK');
    expect(fixture.wasReleased()).toBe(true);
  });
});
