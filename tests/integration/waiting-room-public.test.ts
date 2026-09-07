import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../scripts/db/lib';
import { QueueService } from '@/modules/queue';
import { WaitingRoomService } from '@/modules/waiting-room';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

const ids = {
  clinic: randomUUID(),
  otherClinic: randomUUID(),
  receptionist: randomUUID(),
  doctorUser: randomUUID(),
  doctor: randomUUID(),
  session: randomUUID(),
};

const scope = { clinicId: ids.clinic, actorUserId: ids.receptionist };

beforeAll(async () => migrate());

beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events, queue_reorder_receipts, queue_command_receipts,
    queue_registration_receipts, queue_entries, patient_operational_records,
    session_command_receipts, consultation_sessions, schedule_templates,
    doctor_clinics, doctor_profiles, clinic_memberships, clinics, users CASCADE`);
  await pool.query(
    `INSERT INTO users (id, auth_subject, display_name) VALUES
      ($1, 'wu6-reception', 'Reception'),
      ($2, 'wu6-doctor', 'Doctor')`,
    [ids.receptionist, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO clinics (id, tenant_key, name) VALUES
      ($1, 'wu6-clinic', 'Clinic'),
      ($2, 'wu6-other', 'Other clinic')`,
    [ids.clinic, ids.otherClinic],
  );
  await pool.query(
    `INSERT INTO clinic_memberships (clinic_id, user_id, role)
     VALUES ($1, $2, 'receptionist')`,
    [ids.clinic, ids.receptionist],
  );
  await pool.query(
    `INSERT INTO doctor_profiles (id, user_id, display_name)
     VALUES ($1, $2, 'Doctor')`,
    [ids.doctor, ids.doctorUser],
  );
  await pool.query(
    `INSERT INTO doctor_clinics (clinic_id, doctor_id) VALUES ($1, $2)`,
    [ids.clinic, ids.doctor],
  );
  await pool.query(
    `INSERT INTO consultation_sessions
      (id, clinic_id, doctor_id, service_date, starts_at, ends_at)
     VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + time '09:00', CURRENT_DATE + time '12:00')`,
    [ids.session, ids.clinic, ids.doctor],
  );
});

afterAll(async () => pool.end());

function registrationInput(name: string, key: string) {
  return {
    privateDisplayName: name,
    contactPhone: '+213555000123',
    contactEmail: 'Private.Patient@example.dz',
    preferredLocale: 'fr' as const,
    idempotencyKey: key,
    correlationId: `wu6-${key}`,
  };
}

describe('privacy-preserving waiting-room projection', () => {
  it('returns only public labels and coarse state without patient/contact/internal identifiers', async () => {
    const registration = await new QueueService(pool).registerWalkIn(
      scope,
      ids.session,
      registrationInput('Secret Patient Name', 'public-1'),
    );

    const snapshot = await new WaitingRoomService(pool).getPublicSnapshot(
      ids.clinic,
      ids.session,
    );

    expect(snapshot).toEqual({
      entries: [
        {
          publicDisplayLabel: registration.entry.publicDisplayLabel,
          state: 'waiting',
          called: false,
        },
      ],
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('Secret Patient Name');
    expect(serialized).not.toContain('+213555000123');
    expect(serialized).not.toContain('Private.Patient');
    expect(serialized).not.toContain(registration.patient.id);
    expect(serialized).not.toContain(registration.entry.id);
    expect(serialized).not.toContain(ids.clinic);
    expect(serialized).not.toContain(ids.session);
  });

  it('uses a public label that is independent from the queue-entry UUID', async () => {
    const registration = await new QueueService(pool).registerWalkIn(
      scope,
      ids.session,
      registrationInput('Patient', 'public-2'),
    );

    expect(registration.entry.publicDisplayLabel).toMatch(/^W-[A-F0-9]{10}$/);
    const entryHex = registration.entry.id.replaceAll('-', '').toUpperCase();
    expect(registration.entry.publicDisplayLabel.slice(2)).not.toBe(
      entryHex.slice(0, 10),
    );
  });

  it('is clinic/session scoped and removes terminal entries from the shared display', async () => {
    const queue = new QueueService(pool);
    const registration = await queue.registerWalkIn(
      scope,
      ids.session,
      registrationInput('Patient', 'public-3'),
    );

    const wrongClinic = await new WaitingRoomService(pool).getPublicSnapshot(
      ids.otherClinic,
      ids.session,
    );
    expect(wrongClinic.entries).toEqual([]);

    await pool.query(
      `UPDATE consultation_sessions
          SET status = 'open', opened_at = COALESCE(opened_at, now()), updated_at = now()
        WHERE id = $1 AND clinic_id = $2`,
      [ids.session, ids.clinic],
    );

    await queue.command(scope, ids.session, registration.entry.id, {
      command: 'cancel',
      reason: 'Patient left clinic',
      cancellationSource: 'patient',
      idempotencyKey: 'public-cancel-1',
      correlationId: 'wu6-cancel',
    });

    const afterTerminal = await new WaitingRoomService(pool).getPublicSnapshot(
      ids.clinic,
      ids.session,
    );
    expect(afterTerminal.entries).toEqual([]);
  });

  it('backfills legacy ID-derived labels without churning an existing non-legacy label', async () => {
    const legacyPatientId = randomUUID();
    const safePatientId = randomUUID();
    const legacyEntryId = randomUUID();
    const safeEntryId = randomUUID();
    const legacyLabel = `W-${legacyEntryId.replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const safeLabel = 'W-SAFE-LABEL';

    await pool.query(
      `INSERT INTO patient_operational_records
         (id, clinic_id, private_display_name, preferred_locale)
       VALUES
         ($1, $3, 'Legacy Patient', 'fr'),
         ($2, $3, 'Safe Label Patient', 'fr')`,
      [legacyPatientId, safePatientId, ids.clinic],
    );

    // Simulate rows created before migration 0007's trigger existed. One row
    // has the exact legacy ID-derived label; the other represents a pre-existing
    // non-legacy label that the migration must preserve.
    await pool.query(
      `ALTER TABLE queue_entries DISABLE TRIGGER queue_entries_assign_public_display_label`,
    );
    try {
      await pool.query(
        `INSERT INTO queue_entries
           (id, clinic_id, session_id, patient_id, state, source, registration_order,
            eligibility_order, priority_order, public_display_label)
         VALUES
           ($1, $3, $4, $5, 'waiting', 'walk_in', 1, NULL, NULL, $7),
           ($2, $3, $4, $6, 'waiting', 'walk_in', 2, NULL, NULL, $8)`,
        [
          legacyEntryId,
          safeEntryId,
          ids.clinic,
          ids.session,
          legacyPatientId,
          safePatientId,
          legacyLabel,
          safeLabel,
        ],
      );
    } finally {
      await pool.query(
        `ALTER TABLE queue_entries ENABLE TRIGGER queue_entries_assign_public_display_label`,
      );
    }

    const before = await pool.query<{
      id: string;
      public_display_label: string;
    }>(
      `SELECT id, public_display_label
         FROM queue_entries
        WHERE id = ANY($1::uuid[])
        ORDER BY registration_order`,
      [[legacyEntryId, safeEntryId]],
    );
    expect(before.rows.map((row) => row.public_display_label)).toEqual([
      legacyLabel,
      safeLabel,
    ]);

    // Re-run migration 0007's exact filtered backfill logic. Only the label
    // that exactly matches the legacy W-<UUID prefix> derivation is replaced.
    await pool.query(`
      DO $$
      DECLARE
        entry RECORD;
        candidate text;
      BEGIN
        FOR entry IN
          SELECT id, session_id
            FROM queue_entries
           WHERE public_display_label =
                 'W-' || upper(substr(replace(id::text, '-', ''), 1, 10))
           ORDER BY id
        LOOP
          LOOP
            candidate := 'W-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
            EXIT WHEN NOT EXISTS (
              SELECT 1
                FROM queue_entries
               WHERE session_id = entry.session_id
                 AND public_display_label = candidate
                 AND id <> entry.id
            );
          END LOOP;
          UPDATE queue_entries SET public_display_label = candidate WHERE id = entry.id;
        END LOOP;
      END;
      $$;
    `);

    const after = await pool.query<{
      id: string;
      public_display_label: string;
    }>(
      `SELECT id, public_display_label
         FROM queue_entries
        WHERE id = ANY($1::uuid[])
        ORDER BY registration_order`,
      [[legacyEntryId, safeEntryId]],
    );
    expect(after.rows[0]?.public_display_label).not.toBe(legacyLabel);
    expect(after.rows[0]?.public_display_label).toMatch(/^W-[A-F0-9]{10}$/);
    expect(after.rows[1]?.public_display_label).toBe(safeLabel);
  });
});
