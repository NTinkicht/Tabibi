import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';

// TAB-P0-11 / #717: pin the privacy-minimal shape of the claim-only ETA
// publication evidence table. Adding a column (especially free text, json or a
// patient identifier) or loosening a key CHECK must fail this test.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

beforeAll(migrate);
afterAll(() => pool.end());

describe('eta_publication_claims privacy-minimal shape', () => {
  it('has exactly the allow-listed columns and types', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'eta_publication_claims'
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'clinic_id', data_type: 'uuid' },
      { column_name: 'contract_version', data_type: 'text' },
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'entry_id', data_type: 'uuid' },
      { column_name: 'evaluated_at', data_type: 'timestamp with time zone' },
      { column_name: 'evidence_digest', data_type: 'text' },
      { column_name: 'id', data_type: 'uuid' },
      { column_name: 'prior_epoch', data_type: 'bigint' },
      { column_name: 'session_epoch', data_type: 'bigint' },
      { column_name: 'session_id', data_type: 'uuid' },
    ]);
  });

  it('constrains the only text columns to a version token and a 64-hex digest', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.eta_publication_claims'::regclass AND contype = 'c'`,
    );
    const defs = rows.map((r) => r.def as string);
    expect(
      defs.some(
        (d) =>
          d.includes('contract_version') &&
          d.includes('[a-z][a-z0-9-]*/v[0-9]+'),
      ),
    ).toBe(true);
    expect(
      defs.some(
        (d) => d.includes('evidence_digest') && d.includes('[0-9a-f]{64}'),
      ),
    ).toBe(true);
  });

  it('references only sessions and queue entries, always with the clinic', async () => {
    const { rows } = await pool.query(
      `SELECT confrelid::regclass::text AS target, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public.eta_publication_claims'::regclass AND contype = 'f'
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.target)).toEqual([
      'consultation_sessions',
      'queue_entries',
    ]);
    for (const r of rows) expect(r.def).toContain('clinic_id');
  });
});
