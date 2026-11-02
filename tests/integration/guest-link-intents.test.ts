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
