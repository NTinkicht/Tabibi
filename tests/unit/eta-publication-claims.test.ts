import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  EtaClaimDigestConflictError,
  EtaPublicationClaimService,
  EtaPublicationStaleError,
  computeEtaEvidenceDigest,
} from '@/modules/queue-eta-estimator/publication-claims';
import type { EtaUncertaintySnapshot } from '@/modules/queue-eta-estimator/uncertainty-v1';

const snap = (
  over: Partial<EtaUncertaintySnapshot> = {},
): EtaUncertaintySnapshot => ({
  earliestMinutes: 10,
  expectedMinutes: 15,
  latestMinutes: 25,
  estimateVersion: 'eta-uncertainty/v1',
  queueRevision: 4,
  evaluatedAt: '2026-09-20T09:30:00.000Z',
  explanationCodes: ['a', 'b'],
  countdownEligible: true,
  ...over,
});

describe('computeEtaEvidenceDigest', () => {
  it('is a stable 64-hex digest of the estimate', () => {
    const d = computeEtaEvidenceDigest(snap());
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEtaEvidenceDigest(snap())).toBe(d);
  });
  it('changes with every estimate field', () => {
    const base = computeEtaEvidenceDigest(snap());
    const variants: Partial<EtaUncertaintySnapshot>[] = [
      { earliestMinutes: 11 },
      { expectedMinutes: 16 },
      { latestMinutes: 26 },
      { queueRevision: 5 },
      { explanationCodes: ['b', 'a'] },
      { explanationCodes: ['a'] },
      { countdownEligible: false },
      { evaluatedAt: '2026-09-20T09:31:00.000Z' },
    ];
    for (const v of variants)
      expect(computeEtaEvidenceDigest(snap(v))).not.toBe(base);
  });
  it('treats equal instants in different notations as one digest', () => {
    expect(
      computeEtaEvidenceDigest(
        snap({ evaluatedAt: '2026-09-20T10:30:00+01:00' }),
      ),
    ).toBe(computeEtaEvidenceDigest(snap()));
  });
  it('rejects a non-absolute instant', () => {
    expect(() =>
      computeEtaEvidenceDigest(snap({ evaluatedAt: 'soon' })),
    ).toThrow(TypeError);
  });
});

function service(handler: (sql: string) => unknown) {
  const query = vi.fn(async (sql: string) => handler(sql));
  const client = { query, release: vi.fn() };
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { svc: new EtaPublicationClaimService(pool), query };
}
const target = () => ({
  clinicId: randomUUID(),
  sessionId: randomUUID(),
  entryId: randomUUID(),
});

describe('EtaPublicationClaimService (mocked pool)', () => {
  it('rejects malformed ids and epochs before touching the database', async () => {
    const { svc, query } = service(() => ({ rows: [] }));
    await expect(
      svc.claim(
        { ...target(), clinicId: 'nope' },
        { sessionEpoch: 0, priorEpoch: 0 },
        snap(),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      svc.claim(target(), { sessionEpoch: -1, priorEpoch: 0 }, snap()),
    ).rejects.toThrow(TypeError);
    await expect(
      svc.claim(target(), { sessionEpoch: 0, priorEpoch: 1.5 }, snap()),
    ).rejects.toThrow(TypeError);
    expect(query).not.toHaveBeenCalled();
  });
  it('maps 23505 to a digest conflict and 40001 to stale', async () => {
    const conflict = service((sql) => {
      if (/claim_eta_publication/.test(sql))
        throw Object.assign(new Error('x'), { code: '23505' });
      return { rows: [] };
    });
    await expect(
      conflict.svc.claim(target(), { sessionEpoch: 0, priorEpoch: 0 }, snap()),
    ).rejects.toBeInstanceOf(EtaClaimDigestConflictError);
    const serial = service((sql) => {
      if (/claim_eta_publication/.test(sql))
        throw Object.assign(new Error('x'), { code: '40001' });
      return { rows: [] };
    });
    await expect(
      serial.svc.claim(target(), { sessionEpoch: 0, priorEpoch: 0 }, snap()),
    ).resolves.toEqual({
      outcome: 'stale',
      claimId: null,
      evidenceDigest: null,
    });
  });
  it('rejects unknown outcomes and malformed created claims (fail closed)', async () => {
    const unknown = service((sql) =>
      /claim_eta_publication/.test(sql)
        ? { rows: [{ outcome: 'weird', claim_id: null, claimed_digest: null }] }
        : { rows: [] },
    );
    await expect(
      unknown.svc.claim(target(), { sessionEpoch: 0, priorEpoch: 0 }, snap()),
    ).rejects.toThrow(/unknown outcome/);
    const malformed = service((sql) =>
      /claim_eta_publication/.test(sql)
        ? {
            rows: [
              {
                outcome: 'created',
                claim_id: randomUUID(),
                claimed_digest: 'zz',
              },
            ],
          }
        : { rows: [] },
    );
    await expect(
      malformed.svc.claim(target(), { sessionEpoch: 0, priorEpoch: 0 }, snap()),
    ).rejects.toThrow(/malformed/);
  });
  it('publish gives up with a stale error after bounded recomputation', async () => {
    const { svc } = service((sql) =>
      /claim_eta_publication/.test(sql)
        ? { rows: [{ outcome: 'stale', claim_id: null, claimed_digest: null }] }
        : { rows: [{ session_epoch: '3', prior_epoch: '0' }] },
    );
    const compute = vi.fn(async () => snap());
    await expect(svc.publish(target(), compute, 3)).rejects.toBeInstanceOf(
      EtaPublicationStaleError,
    );
    expect(compute).toHaveBeenCalledTimes(3);
  });
  it('publish treats a missing session as stale and validates maxAttempts', async () => {
    const { svc } = service(() => ({ rows: [] }));
    const compute = vi.fn(async () => snap());
    await expect(svc.publish(target(), compute)).rejects.toBeInstanceOf(
      EtaPublicationStaleError,
    );
    expect(compute).not.toHaveBeenCalled();
    await expect(svc.publish(target(), compute, 0)).rejects.toThrow(RangeError);
  });
});
