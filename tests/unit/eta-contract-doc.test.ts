import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(
  join(process.cwd(), 'docs/architecture/ETA_UNCERTAINTY_CONTRACT.md'),
  'utf8',
);

describe('ETA uncertainty contract: snapshot reads vs atomic publication', () => {
  it('does not describe publication as a queue_revision compare-and-swap', () => {
    expect(doc).not.toMatch(
      /publication must compare-and-swap against the exact `queue_revision`/,
    );
    expect(doc).not.toMatch(/revision 41 cannot be published as revision 42/);
  });

  it('defines epoch-based atomic publication and stale discard', () => {
    for (const term of [
      'snapshot read',
      'session epoch',
      'clinic/doctor prior epoch',
      'claim_eta_publication',
      'never relabelled',
      'fails closed',
      'never returned to a guest or patient',
      'The returned outcome decides, not the inserted row count',
      'read before the ETA inputs are fetched',
      'checks queue-order freshness only',
      'same committed inputs',
    ]) {
      expect(doc).toContain(term);
    }
    expect(doc).toContain('is not an ETA epoch');
  });
});
