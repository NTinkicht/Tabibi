import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationError } from '@/modules/identity';
import {
  EtaNotPublishableError,
  ReceptionistEtaPublisher,
  type ClaimPublisher,
  type DashboardReader,
} from '@/modules/queue-eta-estimator/receptionist-publication';
import { EtaPublicationStaleError } from '@/modules/queue-eta-estimator/publication-claims';
import { ReceptionistDashboardNotFoundError } from '@/modules/receptionist-dashboard';
import type { EtaUncertaintySnapshot } from '@/modules/queue-eta-estimator/uncertainty-v1';

const scope = { clinicId: randomUUID(), actorUserId: randomUUID() };
const sessionId = randomUUID();
const entryId = randomUUID();
const snap: EtaUncertaintySnapshot = {
  earliestMinutes: 10,
  expectedMinutes: 15,
  latestMinutes: 25,
  estimateVersion: 'eta-uncertainty/v1',
  queueRevision: 1,
  evaluatedAt: '2026-09-20T09:30:00.000Z',
  explanationCodes: ['fallback'],
  countdownEligible: true,
};

function harness(role: string | null, entries: unknown[], epochs = true) {
  const query = vi.fn(async (sql: string) => {
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
    return { rows: role ? [{ role }] : [] };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query } as unknown as Pool;
  const claim = vi.fn();
  const claims: ClaimPublisher = {
    readSourceEpochs: vi.fn(async () =>
      epochs ? { sessionEpoch: 1, priorEpoch: 0 } : null,
    ),
    publish: vi.fn(async (_t, compute) => {
      const s = await compute({ sessionEpoch: 1, priorEpoch: 0 });
      claim(s);
      return {
        outcome: 'created' as const,
        claimId: randomUUID(),
        evidenceDigest: 'x',
      };
    }),
  };
  const dashboard: DashboardReader = {
    getSnapshot: vi.fn(async () => ({ entries }) as never),
  };
  return {
    claim,
    claims,
    dashboard,
    publisher: new ReceptionistEtaPublisher(pool, dashboard, claims),
  };
}

describe('ReceptionistEtaPublisher', () => {
  it('publishes the target entry v1 snapshot', async () => {
    const h = harness('receptionist', [
      { id: entryId, eta: { uncertainty: snap } },
    ]);
    const r = await h.publisher.publishForEntry(scope, sessionId, entryId);
    expect(r.outcome).toBe('created');
    expect(h.claim).toHaveBeenCalledWith(snap);
    expect(h.claims.publish).toHaveBeenCalledWith(
      { clinicId: scope.clinicId, sessionId, entryId },
      expect.any(Function),
      3,
    );
  });

  it('refuses a non-staff role before reading epochs or claiming', async () => {
    const h = harness(null, [{ id: entryId, eta: { uncertainty: snap } }]);
    await expect(
      h.publisher.publishForEntry(scope, sessionId, entryId),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(h.claims.readSourceEpochs).not.toHaveBeenCalled();
    expect(h.claims.publish).not.toHaveBeenCalled();
  });

  it('refuses a session outside the scoped clinic without a claim', async () => {
    const h = harness('clinic_admin', [], false);
    await expect(
      h.publisher.publishForEntry(scope, sessionId, entryId),
    ).rejects.toBeInstanceOf(ReceptionistDashboardNotFoundError);
    expect(h.claims.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['entry absent', []],
    ['no eta (terminal)', [{ id: entryId, eta: null }]],
    ['waiting / no v1 snapshot', [{ id: entryId, eta: { patientsAhead: 1 } }]],
  ])('fails closed without a claim: %s', async (_n, entries) => {
    const h = harness('receptionist', entries);
    await expect(
      h.publisher.publishForEntry(scope, sessionId, entryId),
    ).rejects.toBeInstanceOf(EtaNotPublishableError);
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('propagates bounded stale exhaustion and forwards maxAttempts', async () => {
    const h = harness('receptionist', [
      { id: entryId, eta: { uncertainty: snap } },
    ]);
    (h.claims.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new EtaPublicationStaleError(),
    );
    await expect(
      h.publisher.publishForEntry(scope, sessionId, entryId, 5),
    ).rejects.toBeInstanceOf(EtaPublicationStaleError);
    expect(h.claims.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      5,
    );
  });
});
