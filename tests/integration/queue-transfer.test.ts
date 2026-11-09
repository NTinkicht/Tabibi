import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppointmentService } from '@/modules/appointment';
import { AppointmentRecoveryService } from '@/modules/appointment/recovery';
import { GuestAccessService, verifier } from '@/modules/guest-access';
import { GuestLinkEnvelope } from '@/modules/guest-access/link-envelope';
import { QueueConflictError, QueueService } from '@/modules/queue';
import { QueueRestoreService } from '@/modules/queue/restore';
import { QueueTransferService } from '@/modules/queue/transfer';
import { migrate } from '../../scripts/db/lib';

// TAB-P0-07 (#810 slice 2): staff transfer of walk-in/guest entries between
// sessions of the same doctor. Appointment transfer stays in appointment recovery.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctorRole: randomUUID(),
  outsider: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
  closed: randomUUID(),
  target: randomUUID(),
  otherDoctor: randomUUID(),
  otherDoctorSession: randomUUID(),
  otherDoctorUser: randomUUID(),
  patient: randomUUID(),
};
const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };
let seq = 0;
const key = () => `qr-${++seq}`;
const queue = () => new QueueService(pool);
const ENVELOPE_SECRET = 'x'.repeat(48);
const transferSvc = (withEnvelope = true) =>
  new QueueTransferService(
    pool,
    withEnvelope ? new GuestLinkEnvelope(ENVELOPE_SECRET) : undefined,
  );

beforeAll(async () => migrate());
beforeEach(async () => {
  await pool.query(`TRUNCATE appointment_recovery_receipts,
    appointment_lifecycle_receipts, appointment_booking_receipts, appointments,
    audit_events, queue_command_receipts, queue_reorder_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES
      ($1,'qr-reception','Reception'),($2,'qr-doctor','Doctor'),
      ($3,'qr-doctor-role','Doctor Role'),($4,'qr-outsider','Outsider')`,
    [ids.receptionist, ids.doctorUser, ids.doctorRole, ids.outsider],
  );
  await pool.query(
    `INSERT INTO clinics(id,tenant_key,name) VALUES
      ($1,'qr-a','QR Clinic'),($2,'qr-b','QR Other')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships(clinic_id,user_id,role) VALUES
      ($1,$2,'receptionist'),($1,$3,'doctor'),($4,$5,'clinic_admin')`,
    [
      ids.clinic,
      ids.receptionist,
      ids.doctorRole,
      ids.otherClinic,
      ids.outsider,
    ],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr QR')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES
      ($1,$3,$4,'2026-09-18','2026-09-18 09:00Z','2026-09-18 12:00Z','open'),
      ($2,$3,$4,'2026-09-19','2026-09-19 09:00Z','2026-09-19 12:00Z','closed')`,
    [ids.session, ids.closed, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES ($1,$2,$3,'2026-09-20','2026-09-20 09:00Z','2026-09-20 12:00Z','planned')`,
    [ids.target, ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO users(id,auth_subject,display_name) VALUES($1,'qr-doctor2','Doctor 2')`,
    [ids.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_profiles(id,user_id,display_name) VALUES($1,$2,'Dr Two')`,
    [ids.otherDoctor, ids.otherDoctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics(clinic_id,doctor_id) VALUES($1,$2)`,
    [ids.clinic, ids.otherDoctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id,clinic_id,doctor_id,service_date,starts_at,ends_at,status)
      VALUES ($1,$2,$3,'2026-09-18','2026-09-18 13:00Z','2026-09-18 15:00Z','open')`,
    [ids.otherDoctorSession, ids.clinic, ids.otherDoctor],
  );
  await pool.query(
    `INSERT INTO patient_operational_records
      (id,clinic_id,private_display_name,preferred_locale)
      VALUES($1,$2,'QR Patient','fr')`,
    [ids.patient, ids.clinic],
  );
});
afterAll(async () => pool.end());

async function walkIn(name: string, contactPhone?: string) {
  const item = await queue().registerWalkIn(scope, ids.session, {
    privateDisplayName: name,
    contactPhone,
    preferredLocale: 'ar',
    idempotencyKey: key(),
    correlationId: 'qr-register',
  });
  return item.entry.id;
}
async function cmd(
  entryId: string,
  command: Parameters<QueueService['command']>[3]['command'],
) {
  return queue().command(scope, ids.session, entryId, {
    command,
    reason: 'because',
    cancellationSource: command === 'cancel' ? 'clinic' : undefined,
    idempotencyKey: key(),
    correlationId: 'qr-cmd',
  });
}
function transfer(
  entryId: string,
  targetSessionId = ids.target,
  idempotencyKey = key(),
  sessionId = ids.session,
  withEnvelope = true,
) {
  return transferSvc(withEnvelope).transfer(scope, sessionId, entryId, {
    targetSessionId,
    reason: 'Doctor moved the consultation',
    idempotencyKey,
    correlationId: 'qr-transfer',
  });
}
const versionOf = async (id: string) =>
  Number(
    (
      await pool.query<{ v: string }>(
        'SELECT queue_order_version v FROM consultation_sessions WHERE id=$1',
        [id],
      )
    ).rows[0]!.v,
  );
const stateOf = async (id: string) =>
  (
    await pool.query<{ state: string }>(
      'SELECT state FROM queue_entries WHERE id=$1',
      [id],
    )
  ).rows[0]!.state;

describe('walk-in queue transfer', () => {
  it('keeps a waiting entry waiting at the target and cancels the source', async () => {
    const a = await walkIn('A');
    const v = [await versionOf(ids.session), await versionOf(ids.target)];
    const result = await transfer(a);
    expect(result.source).toMatchObject({ id: a, state: 'cancelled' });
    expect(result.target).toMatchObject({
      sessionId: ids.target,
      state: 'waiting',
      eligibilityOrder: null,
      priorityOrder: null,
      registrationOrder: 1,
      privateDisplayName: 'A',
    });
    expect(result.target.id).not.toBe(a);
    expect(await versionOf(ids.session)).toBe(v[0]! + 1);
    expect(await versionOf(ids.target)).toBe(v[1]! + 1);
  });

  it('turns checked_in and called into checked_in at the target tail without priority', async () => {
    const existing = await walkIn('Existing');
    const a = await walkIn('A');
    const b = await walkIn('B');
    await cmd(a, 'check_in');
    await cmd(b, 'check_in');
    await cmd(a, 'call');
    await pool.query('UPDATE queue_entries SET priority_order=1 WHERE id=$1', [
      b,
    ]);
    await transfer(existing);
    const ta = await transfer(a);
    const tb = await transfer(b);
    expect(ta.target).toMatchObject({
      state: 'checked_in',
      eligibilityOrder: 1,
      priorityOrder: null,
    });
    expect(tb.target).toMatchObject({
      state: 'checked_in',
      eligibilityOrder: 2,
      priorityOrder: null,
    });
    expect(await stateOf(a)).toBe('cancelled');
    expect(await stateOf(b)).toBe('cancelled');
  });

  it('compacts the source priority queue when a prioritised entry leaves', async () => {
    const a = await walkIn('A');
    const b = await walkIn('B');
    await cmd(a, 'check_in');
    await cmd(b, 'check_in');
    await pool.query('UPDATE queue_entries SET priority_order=1 WHERE id=$1', [
      a,
    ]);
    await pool.query('UPDATE queue_entries SET priority_order=2 WHERE id=$1', [
      b,
    ]);
    await transfer(a);
    const rows = await pool.query(
      'SELECT priority_order p FROM queue_entries WHERE id=$1',
      [b],
    );
    expect(Number(rows.rows[0].p)).toBe(1);
  });

  it('refuses in_consultation, completed, cancelled and no_show sources', async () => {
    const a = await walkIn('A');
    await cmd(a, 'check_in');
    await cmd(a, 'call');
    await cmd(a, 'start_consultation');
    await expect(transfer(a)).rejects.toThrow(
      /Cannot transfer queue entry in in_consultation/,
    );
    await cmd(a, 'complete_consultation');
    await expect(transfer(a)).rejects.toThrow(/completed/);
    const b = await walkIn('B');
    await cmd(b, 'cancel');
    await expect(transfer(b)).rejects.toThrow(/cancelled/);
    const c = await walkIn('C');
    await cmd(c, 'check_in');
    await cmd(c, 'no_show');
    await expect(transfer(c)).rejects.toThrow(/no_show/);
    const count = await pool.query(
      'SELECT count(*)::int n FROM queue_entries WHERE session_id=$1',
      [ids.target],
    );
    expect(count.rows[0].n).toBe(0);
  });

  it('refuses a closed target, another doctor, the same session and appointment-backed entries', async () => {
    const a = await walkIn('A');
    await expect(transfer(a, ids.closed)).rejects.toThrow(/not accepting/);
    await expect(transfer(a, ids.otherDoctorSession)).rejects.toThrow(
      /doctor does not match/,
    );
    await expect(transfer(a, ids.session)).rejects.toThrow(/must differ/);
    await expect(transfer(a, randomUUID())).rejects.toThrow(/not found/);
    await pool.query(
      `UPDATE queue_entries SET source='appointment' WHERE id=$1`,
      [a],
    );
    await expect(transfer(a)).rejects.toThrow(/appointment recovery/);
    expect(await stateOf(a)).toBe('waiting');
  });

  it('refuses when the patient already has an active entry in the target', async () => {
    const a = await walkIn('A');
    const first = await transfer(a);
    // Same patient back into the source session, then transfer again: the
    // target already holds an active entry for that patient.
    await pool.query(
      `INSERT INTO queue_entries(id,clinic_id,session_id,patient_id,state,source,registration_order)
       SELECT $1,clinic_id,$2,patient_id,'waiting','walk_in',99 FROM queue_entries WHERE id=$3`,
      [randomUUID(), ids.session, first.target.id],
    );
    const dup = await pool.query<{ id: string }>(
      `SELECT id FROM queue_entries WHERE session_id=$1 AND registration_order=99`,
      [ids.session],
    );
    await expect(transfer(dup.rows[0]!.id)).rejects.toThrow(
      /already has an active queue entry/,
    );
  });

  it('is idempotent and rejects key reuse for a different request', async () => {
    const a = await walkIn('A');
    const k = key();
    const first = await transfer(a, ids.target, k);
    const v = await versionOf(ids.target);
    expect(await transfer(a, ids.target, k)).toEqual(first);
    expect(await versionOf(ids.target)).toBe(v);
    await expect(transfer(a, ids.closed, k)).rejects.toThrow(
      /different queue command/,
    );
    const audits = await pool.query(
      `SELECT metadata FROM audit_events WHERE action='queue_entry.transfer'`,
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].metadata).toMatchObject({
      sourceTerminalCause: 'transfer',
      from: 'waiting',
      to: 'waiting',
      targetSessionId: ids.target,
      targetQueueEntryId: first.target.id,
    });
  });

  it('serializes concurrent transfers of one entry to exactly one success', async () => {
    const a = await walkIn('A');
    const results = await Promise.allSettled([
      transfer(a),
      transfer(a),
      transfer(a),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const n = await pool.query(
      'SELECT count(*)::int n FROM queue_entries WHERE session_id=$1',
      [ids.target],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('revokes every source guest credential, exchange and pending link intent, even after the source is restored', async () => {
    const a = await walkIn('A');
    await pool.query(
      `INSERT INTO guest_credentials
         (id,clinic_id,session_id,queue_entry_id,bearer_verifier,expires_at)
       VALUES ($1,$2,$3,$4,$5,now() + interval '1 hour')`,
      [randomUUID(), ids.clinic, ids.session, a, 'c'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO guest_exchange_ids
         (id,clinic_id,session_id,queue_entry_id,issued_by_user_id,exchange_verifier,contact_kind,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'phone',now() + interval '5 minutes')`,
      [
        randomUUID(),
        ids.clinic,
        ids.session,
        a,
        ids.receptionist,
        'd'.repeat(64),
      ],
    );
    await pool.query(
      `INSERT INTO guest_link_intents
         (id,clinic_id,queue_entry_id,intent,envelope_ciphertext,expires_at)
       VALUES ($1,$2,$3,'initial','ciphertext',now() + interval '5 minutes')`,
      [randomUUID(), ids.clinic, a],
    );
    // Control: all three are live before the transfer.
    const live = async () =>
      (
        await pool.query<{ c: number; e: number; i: number }>(
          `SELECT
             (SELECT count(*)::int FROM guest_credentials WHERE queue_entry_id=$1 AND revoked_at IS NULL) c,
             (SELECT count(*)::int FROM guest_exchange_ids WHERE queue_entry_id=$1 AND consumed_at IS NULL) e,
             (SELECT count(*)::int FROM guest_link_intents WHERE queue_entry_id=$1 AND state='pending') i`,
          [a],
        )
      ).rows[0];
    expect(await live()).toEqual({ c: 1, e: 1, i: 1 });
    const result = await transfer(a);
    expect(await live()).toEqual({ c: 0, e: 0, i: 0 });
    const intent = await pool.query(
      `SELECT state, envelope_ciphertext FROM guest_link_intents WHERE queue_entry_id=$1`,
      [a],
    );
    expect(intent.rows[0]).toEqual({
      state: 'expired',
      envelope_ciphertext: null,
    });
    // The target carries no guest authority until a fresh exchange is consumed.
    const targetAuth = await pool.query(
      `SELECT (SELECT count(*)::int FROM guest_credentials WHERE queue_entry_id=$1) c`,
      [result.target.id],
    );
    expect(targetAuth.rows[0].c).toBe(0);
    // Restoring the cancelled source must not revive the old authority.
    await new QueueRestoreService(pool).restore(scope, ids.session, a, {
      checkIn: false,
      reason: 'Undo',
      idempotencyKey: key(),
      correlationId: 'x',
    });
    expect(await live()).toEqual({ c: 0, e: 0, i: 0 });
  });

  describe('fresh target guest link (#841)', () => {
    async function liveSourceCredential(entryId: string) {
      await pool.query(
        `INSERT INTO guest_credentials
           (id,clinic_id,session_id,queue_entry_id,bearer_verifier,expires_at)
         VALUES ($1,$2,$3,$4,$5,now() + interval '1 hour')`,
        [randomUUID(), ids.clinic, ids.session, entryId, 'c'.repeat(64)],
      );
    }
    const targetAccess = async (targetId: string) =>
      (
        await pool.query<{ e: number; i: number; c: number }>(
          `SELECT
             (SELECT count(*)::int FROM guest_exchange_ids WHERE queue_entry_id=$1 AND consumed_at IS NULL) e,
             (SELECT count(*)::int FROM guest_link_intents WHERE queue_entry_id=$1 AND intent='transfer' AND state='pending') i,
             (SELECT count(*)::int FROM guest_credentials WHERE queue_entry_id=$1) c`,
          [targetId],
        )
      ).rows[0]!;

    it('mints one target-bound single-use exchange and sealed transfer intent, usable once, with old authority dead', async () => {
      const a = await walkIn('A', '+213555000111');
      await liveSourceCredential(a);
      const result = await transfer(a);
      const targetId = result.target.id;
      expect(await targetAccess(targetId)).toEqual({ e: 1, i: 1, c: 0 });
      const intent = (
        await pool.query<{ id: string; envelope_ciphertext: string }>(
          `SELECT id, envelope_ciphertext FROM guest_link_intents
            WHERE queue_entry_id=$1 AND intent='transfer'`,
          [targetId],
        )
      ).rows[0]!;
      expect(intent.envelope_ciphertext).not.toContain('exchange');
      const material = new GuestLinkEnvelope(ENVELOPE_SECRET).open(
        {
          intent: 'transfer',
          intentId: intent.id,
          entryId: targetId,
          clinicId: ids.clinic,
        },
        intent.envelope_ciphertext,
      );
      const exchange = (
        await pool.query<{
          exchange_verifier: string;
          session_id: string;
          queue_entry_id: string;
        }>(
          `SELECT exchange_verifier, session_id, queue_entry_id
             FROM guest_exchange_ids WHERE queue_entry_id=$1`,
          [targetId],
        )
      ).rows[0]!;
      expect(exchange.exchange_verifier).toBe(verifier(material));
      expect(exchange.session_id).toBe(ids.target);
      // The old source authority is dead: nothing live remains on the source.
      const src = await pool.query(
        `SELECT 1 FROM guest_credentials WHERE queue_entry_id=$1 AND revoked_at IS NULL`,
        [a],
      );
      expect(src.rowCount).toBe(0);
      // The fresh link works exactly once and only for the target entry.
      const guest = new GuestAccessService(pool);
      const consumed = await guest.consume(material);
      expect(consumed.target.queueEntryId).toBe(targetId);
      await expect(guest.consume(material)).rejects.toThrow();
    });

    it('ignores an expired pending source intent when deciding whether to mint a link', async () => {
      const expired = await walkIn('E', '+213555000333');
      await pool.query(
        `INSERT INTO guest_link_intents
           (id,clinic_id,queue_entry_id,intent,envelope_ciphertext,created_at,expires_at)
         VALUES ($1,$2,$3,'initial','x',now() - interval '20 minutes',now() - interval '10 minutes')`,
        [randomUUID(), ids.clinic, expired],
      );
      expect(await targetAccess((await transfer(expired)).target.id)).toEqual({
        e: 0,
        i: 0,
        c: 0,
      });
      // Positive control: an unexpired pending intent does carry access.
      const live = await walkIn('F', '+213555000444');
      await pool.query(
        `INSERT INTO guest_link_intents
           (id,clinic_id,queue_entry_id,intent,envelope_ciphertext,created_at,expires_at)
         VALUES ($1,$2,$3,'initial','x',now(),now() + interval '5 minutes')`,
        [randomUUID(), ids.clinic, live],
      );
      expect((await targetAccess((await transfer(live)).target.id)).i).toBe(1);
    });

    it('creates no link without prior guest access or without a contact', async () => {
      const noAccess = await walkIn('B', '+213555000222');
      expect(await targetAccess((await transfer(noAccess)).target.id)).toEqual({
        e: 0,
        i: 0,
        c: 0,
      });
      const noContact = await walkIn('C');
      await liveSourceCredential(noContact);
      expect(await targetAccess((await transfer(noContact)).target.id)).toEqual(
        { e: 0, i: 0, c: 0 },
      );
    });

    it('replays idempotently without minting a second link', async () => {
      const a = await walkIn('A', '+213555000333');
      await liveSourceCredential(a);
      const idem = key();
      const first = await transfer(a, ids.target, idem);
      const second = await transfer(a, ids.target, idem);
      expect(second.target.id).toBe(first.target.id);
      expect(await targetAccess(first.target.id)).toEqual({
        e: 1,
        i: 1,
        c: 0,
      });
    });

    it('fails the whole transfer closed when the envelope is not configured', async () => {
      const a = await walkIn('A', '+213555000444');
      await liveSourceCredential(a);
      await expect(
        transfer(a, ids.target, key(), ids.session, false),
      ).rejects.toThrow('envelope');
      expect(await stateOf(a)).toBe('waiting');
      const live = await pool.query(
        `SELECT 1 FROM guest_credentials WHERE queue_entry_id=$1 AND revoked_at IS NULL`,
        [a],
      );
      expect(live.rowCount).toBe(1);
      // Positive control: with the envelope the same transfer succeeds.
      const ok = await transfer(a);
      expect((await targetAccess(ok.target.id)).i).toBe(1);
    });
  });

  it('requires a reason and a receptionist or clinic admin', async () => {
    const a = await walkIn('A');
    await expect(
      transferSvc().transfer(scope, ids.session, a, {
        targetSessionId: ids.target,
        reason: '  ',
        idempotencyKey: key(),
        correlationId: 'x',
      }),
    ).rejects.toThrow(/reason is required/);
    for (const actor of [ids.doctorRole, ids.outsider])
      await expect(
        transferSvc().transfer(
          { clinicId: ids.clinic, actorUserId: actor },
          ids.session,
          a,
          {
            targetSessionId: ids.target,
            reason: 'x',
            idempotencyKey: key(),
            correlationId: 'x',
          },
        ),
      ).rejects.toThrow();
    expect(await stateOf(a)).toBe('waiting');
    // Positive control: the receptionist succeeds with the same payload.
    await expect(transfer(a)).resolves.toBeDefined();
  });
});
