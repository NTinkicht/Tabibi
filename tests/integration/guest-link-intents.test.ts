import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { GuestLinkIntentStore } from '@/modules/guest-access/link-intents';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const SECRET = 'x'.repeat(48);
const MATERIAL = 'plaintext-exchange-link-material-9f3c';
const clinicId = randomUUID();
const otherClinicId = randomUUID();
const doctorUser = randomUUID();
const doctorId = randomUUID();
const sessionId = randomUUID();
const entryId = randomUUID();
let now = new Date('2026-11-02T10:00:00Z');
const clock = () => now;
const store = new GuestLinkIntentStore(
  pool,
  new GuestLinkEnvelope(SECRET, clock),
  clock,
);
const deadline = () => new Date(now.getTime() + 10 * 60 * 1000);

async function row(id: string) {
  const r = await pool.query<{
    state: string;
    envelope_ciphertext: string | null;
    scrubbed_at: Date | null;
  }>(
    'SELECT state, envelope_ciphertext, scrubbed_at FROM guest_link_intents WHERE id=$1',
    [id],
  );
  return r.rows[0]!;
}

beforeAll(async () => migrate());
afterAll(async () => pool.end());
beforeEach(async () => {
  now = new Date('2026-11-02T10:00:00Z');
  await pool.query(`TRUNCATE guest_link_intents, queue_entries,
    patient_operational_records, consultation_sessions, doctor_clinics,
    doctor_profiles, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'gli-doc','Doc')`,
    [doctorUser],
  );
  for (const [id, key] of [
    [clinicId, 'gli-a'],
    [otherClinicId, 'gli-b'],
  ] as const) {
    await pool.query(
      `INSERT INTO clinics(id,tenant_key,name) VALUES($1,$2,$2)`,
      [id, key],
    );
  }
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr')`,
    [doctorId, doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [clinicId, doctorId],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
       (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
     VALUES($1,$2,$3,now()::date,now()-interval '1 hour',
            now()+interval '2 hours','open')`,
    [sessionId, clinicId, doctorId],
  );
  const patientId = randomUUID();
  await pool.query(
    `INSERT INTO patient_operational_records
       (id,clinic_id,private_display_name,preferred_locale)
     VALUES($1,$2,'Guest','ar')`,
    [patientId, clinicId],
  );
  await pool.query(
    `INSERT INTO queue_entries
       (id,clinic_id,session_id,patient_id,state,source,
        registration_order,public_display_label)
     VALUES($1,$2,$3,$4,'waiting','walk_in',1,'GLI-1')`,
    [entryId, clinicId, sessionId, patientId],
  );
});

const input = () => ({
  clinicId,
  queueEntryId: entryId,
  intent: 'initial' as const,
  material: MATERIAL,
  exchangeExpiresAt: deadline(),
});

describe('guest link intents, real PostgreSQL (#743)', () => {
  it('stores only envelope ciphertext, never the plaintext material', async () => {
    const id = await store.create(input());
    const stored = await row(id);
    expect(stored.state).toBe('pending');
    expect(stored.envelope_ciphertext).toMatch(/^gle1\./);
    const dump = await pool.query(
      'SELECT row_to_json(t)::text AS j FROM guest_link_intents t WHERE id=$1',
      [id],
    );
    expect(dump.rows[0].j).not.toContain(MATERIAL);
  });

  it('scrubs ciphertext atomically on delivered and dead_letter, once', async () => {
    const a = await store.create(input());
    const b = await store.create(input());
    expect(await store.markTerminal(clinicId, a, 'delivered')).toBe(true);
    expect(await store.markTerminal(clinicId, b, 'dead_letter')).toBe(true);
    for (const [id, state] of [
      [a, 'delivered'],
      [b, 'dead_letter'],
    ] as const) {
      const r = await row(id);
      expect(r.state).toBe(state);
      expect(r.envelope_ciphertext).toBeNull();
      expect(r.scrubbed_at).not.toBeNull();
    }
    expect(await store.markTerminal(clinicId, a, 'dead_letter')).toBe(false);
    expect((await row(a)).state).toBe('delivered');
  });

  it('does not transition an intent through another clinic', async () => {
    const id = await store.create(input());
    expect(await store.markTerminal(otherClinicId, id, 'delivered')).toBe(
      false,
    );
    const r = await row(id);
    expect(r.state).toBe('pending');
    expect(r.envelope_ciphertext).not.toBeNull();
  });

  it('expires and scrubs only past-deadline pending intents', async () => {
    const id = await store.create(input());
    now = new Date(now.getTime() + 9 * 60 * 1000);
    expect(await store.scrubExpired()).toBe(0);
    expect((await row(id)).envelope_ciphertext).not.toBeNull();
    now = new Date(now.getTime() + 60 * 1000);
    expect(await store.scrubExpired()).toBe(1);
    const r = await row(id);
    expect(r.state).toBe('expired');
    expect(r.envelope_ciphertext).toBeNull();
    expect(await store.scrubExpired()).toBe(0);
  });

  it('database rejects ciphertext on terminal rows and TTL above ten minutes', async () => {
    const id = await store.create(input());
    await store.markTerminal(clinicId, id, 'delivered');
    await expect(
      pool.query(
        `UPDATE guest_link_intents SET envelope_ciphertext='x' WHERE id=$1`,
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO guest_link_intents
           (id,clinic_id,queue_entry_id,intent,envelope_ciphertext,created_at,expires_at)
         VALUES($1,$2,$3,'initial','gle1.x',now(),now()+interval '11 minutes')`,
        [randomUUID(), clinicId, entryId],
      ),
    ).rejects.toThrow();
  });

  it('rejects an entry from another clinic and fails closed on a short secret', async () => {
    await expect(
      store.create({ ...input(), clinicId: otherClinicId }),
    ).rejects.toThrow();
    expect(() => new GuestLinkEnvelope('short', clock)).toThrow();
  });

  it('converges under concurrent markTerminal and scrubExpired', async () => {
    const id = await store.create(input());
    now = new Date(now.getTime() + 11 * 60 * 1000);
    const [terminal, scrubbed] = await Promise.all([
      store.markTerminal(clinicId, id, 'delivered'),
      store.scrubExpired(),
    ]);
    expect(Number(terminal) + scrubbed).toBe(1);
    const r = await row(id);
    expect(['delivered', 'expired']).toContain(r.state);
    expect(r.envelope_ciphertext).toBeNull();
  });
});

describe('guest link intent dispatch, real PostgreSQL (#745)', () => {
  const ok = async () => undefined;

  it('returns none when nothing is due', async () => {
    expect(await store.dispatchNext(ok)).toBe('none');
  });

  it('decrypts only at dispatch and scrubs after delivery', async () => {
    const id = await store.create(input());
    const seen: Array<{ material: string; key: string }> = [];
    const out = await store.dispatchNext(async (material, ctx) => {
      seen.push({ material, key: ctx.idempotencyKey });
    });
    expect(out).toBe('delivered');
    expect(seen).toEqual([{ material: MATERIAL, key: id }]);
    const r = await row(id);
    expect(r.state).toBe('delivered');
    expect(r.envelope_ciphertext).toBeNull();
    expect(await store.dispatchNext(ok)).toBe('none');
  });

  it('retries with backoff and a stable idempotency key, then delivers', async () => {
    const id = await store.create(input());
    const keys: string[] = [];
    const fail = async (_m: string, ctx: { idempotencyKey: string }) => {
      keys.push(ctx.idempotencyKey);
      throw new Error('provider outage');
    };
    expect(await store.dispatchNext(fail, { backoffMs: 1000 })).toBe(
      'retry_scheduled',
    );
    expect(await store.dispatchNext(ok)).toBe('none');
    now = new Date(now.getTime() + 1500);
    expect(await store.dispatchNext(fail, { backoffMs: 1000 })).toBe(
      'retry_scheduled',
    );
    now = new Date(now.getTime() + 2500);
    expect(
      await store.dispatchNext(async (_m, ctx) => {
        keys.push(ctx.idempotencyKey);
      }),
    ).toBe('delivered');
    expect(keys).toEqual([id, id, id]);
    const r = await row(id);
    expect(r.state).toBe('delivered');
    expect(r.envelope_ciphertext).toBeNull();
  });

  it('dead-letters after max attempts and scrubs the ciphertext', async () => {
    const id = await store.create(input());
    const fail = async () => {
      throw new Error('provider outage');
    };
    expect(
      await store.dispatchNext(fail, { maxAttempts: 2, backoffMs: 1000 }),
    ).toBe('retry_scheduled');
    now = new Date(now.getTime() + 1500);
    expect(
      await store.dispatchNext(fail, { maxAttempts: 2, backoffMs: 1000 }),
    ).toBe('dead_letter');
    const r = await row(id);
    expect(r.state).toBe('dead_letter');
    expect(r.envelope_ciphertext).toBeNull();
  });

  it('dead-letters a wrong-key envelope without calling the sender', async () => {
    const id = await store.create(input());
    const other = new GuestLinkIntentStore(
      pool,
      new GuestLinkEnvelope('y'.repeat(48), clock),
      clock,
    );
    let called = 0;
    const out = await other.dispatchNext(async () => {
      called += 1;
    });
    expect(out).toBe('dead_letter');
    expect(called).toBe(0);
    const r = await row(id);
    expect(r.state).toBe('dead_letter');
    expect(r.envelope_ciphertext).toBeNull();
  });

  it('never decrypts or sends an expired intent', async () => {
    const id = await store.create(input());
    now = new Date(now.getTime() + 10 * 60 * 1000 + 1);
    let called = 0;
    expect(
      await store.dispatchNext(async () => {
        called += 1;
      }),
    ).toBe('none');
    expect(called).toBe(0);
    expect(await store.scrubExpired()).toBe(1);
    expect((await row(id)).envelope_ciphertext).toBeNull();
  });

  it('concurrent workers send each intent exactly once', async () => {
    await store.create(input());
    await store.create(input());
    const sent: string[] = [];
    const send = async (_m: string, ctx: { intentId: string }) => {
      await new Promise((r) => setTimeout(r, 20));
      sent.push(ctx.intentId);
    };
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => store.dispatchNext(send)),
    );
    expect(outcomes.filter((o) => o === 'delivered')).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    expect(sent).toHaveLength(2);
  });

  it('lets a restarted worker take over a lapsed lease only', async () => {
    const id = await store.create(input());
    await pool.query(
      `UPDATE guest_link_intents SET claimed_until = $2, attempts = 1 WHERE id = $1`,
      [id, new Date(now.getTime() + 60_000)],
    );
    expect(await store.dispatchNext(ok)).toBe('none');
    now = new Date(now.getTime() + 61_000);
    expect(await store.dispatchNext(ok)).toBe('delivered');
  });

  it('dead-letters without sending when a crashed claim exhausted attempts', async () => {
    const id = await store.create(input());
    await pool.query(
      `UPDATE guest_link_intents SET attempts = 2, claimed_until = $2 WHERE id = $1`,
      [id, new Date(now.getTime() + 1000)],
    );
    now = new Date(now.getTime() + 2000);
    let called = 0;
    const out = await store.dispatchNext(
      async () => {
        called += 1;
      },
      { maxAttempts: 2 },
    );
    expect(out).toBe('none');
    expect(called).toBe(0);
    const r = await row(id);
    expect(r.state).toBe('dead_letter');
    expect(r.envelope_ciphertext).toBeNull();
  });

  it('fences a slow sender so a replaced worker cannot clobber the new claim', async () => {
    const id = await store.create(input());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = store.dispatchNext(
      async () => {
        await gate;
        throw new Error('late failure');
      },
      { leaseMs: 1000, maxAttempts: 1 + 1 },
    );
    await new Promise((r) => setTimeout(r, 100));
    now = new Date(now.getTime() + 2000);
    const fresh = store.dispatchNext(
      async () => {
        release();
        await slow;
      },
      { leaseMs: 60_000, maxAttempts: 5 },
    );
    expect(await fresh).toBe('delivered');
    expect(await slow).toBe('none');
    const r = await row(id);
    expect(r.state).toBe('delivered');
    expect(r.envelope_ciphertext).toBeNull();
  });
});
