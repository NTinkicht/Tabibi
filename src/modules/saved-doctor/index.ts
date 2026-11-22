import type { Pool } from 'pg';
import { activeDoctorAssociationSql } from '@/modules/clinic/active-doctor';

export const SAVED_DOCTOR_LIMIT = 50;

export interface SavedDoctor {
  clinicId: string;
  clinicName: string;
  doctorId: string;
  displayName: string;
  savedAt: string;
}

export class SavedDoctorValidationError extends Error {
  constructor() {
    super('Saved doctor input is invalid');
    this.name = 'SavedDoctorValidationError';
  }
}

export class SavedDoctorNotFoundError extends Error {
  constructor() {
    super('Doctor not found');
    this.name = 'SavedDoctorNotFoundError';
  }
}

export class SavedDoctorLimitError extends Error {
  constructor() {
    super('Saved doctor limit reached');
    this.name = 'SavedDoctorLimitError';
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: string): string {
  const trimmed = value.trim();
  if (!uuidPattern.test(trimmed)) throw new SavedDoctorValidationError();
  return trimmed.toLowerCase();
}

/**
 * Doctors bookmarked by one authenticated patient account. The owner always
 * comes from the verified patient session, never from request input. Only a
 * doctor with a non-departed association to an active clinic can be saved or
 * listed, matching the public bookable-session rules.
 */
export class SavedDoctorService {
  constructor(private readonly pool: Pool) {}

  async list(ownerUserId: string): Promise<SavedDoctor[]> {
    const owner = uuid(ownerUserId);
    const { rows } = await this.pool.query<{
      clinic_id: string;
      clinic_name: string;
      doctor_id: string;
      display_name: string;
      created_at: Date;
    }>(
      `SELECT saved.clinic_id, clinic.name AS clinic_name, saved.doctor_id,
              doctor.display_name, saved.created_at
         FROM patient_saved_doctors saved
         JOIN clinics clinic ON clinic.id = saved.clinic_id
         JOIN doctor_profiles doctor ON doctor.id = saved.doctor_id
         JOIN doctor_clinics association
           ON association.clinic_id = saved.clinic_id
          AND association.doctor_id = saved.doctor_id
        WHERE saved.owner_user_id = $1
          AND clinic.status = 'active'
          AND ${activeDoctorAssociationSql('association')}
        ORDER BY saved.created_at DESC, saved.clinic_id, saved.doctor_id`,
      [owner],
    );
    return rows.map((row) => ({
      clinicId: row.clinic_id,
      clinicName: row.clinic_name,
      doctorId: row.doctor_id,
      displayName: row.display_name,
      savedAt: row.created_at.toISOString(),
    }));
  }

  /** Idempotent save. Returns whether a new row was created. */
  async save(
    ownerUserId: string,
    clinicIdInput: string,
    doctorIdInput: string,
  ): Promise<{ created: boolean }> {
    const owner = uuid(ownerUserId);
    const clinicId = uuid(clinicIdInput);
    const doctorId = uuid(doctorIdInput);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serializes concurrent saves of one account so the cap cannot be raced.
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [
        owner,
      ]);
      const target = await client.query(
        `SELECT 1
           FROM clinics clinic
           JOIN doctor_clinics association ON association.clinic_id = clinic.id
          WHERE clinic.id = $1 AND association.doctor_id = $2
            AND clinic.status = 'active'
            AND ${activeDoctorAssociationSql('association')}
          FOR SHARE OF association`,
        [clinicId, doctorId],
      );
      if (target.rowCount === 0) throw new SavedDoctorNotFoundError();
      const inserted = await client.query(
        `INSERT INTO patient_saved_doctors (owner_user_id, clinic_id, doctor_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [owner, clinicId, doctorId],
      );
      if (inserted.rowCount === 1) {
        const count = await client.query<{ n: string }>(
          'SELECT count(*) AS n FROM patient_saved_doctors WHERE owner_user_id = $1',
          [owner],
        );
        if (Number(count.rows[0]!.n) > SAVED_DOCTOR_LIMIT)
          throw new SavedDoctorLimitError();
      }
      await client.query('COMMIT');
      return { created: inserted.rowCount === 1 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Idempotent removal of the owner's own bookmark. */
  async remove(
    ownerUserId: string,
    clinicIdInput: string,
    doctorIdInput: string,
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM patient_saved_doctors
        WHERE owner_user_id = $1 AND clinic_id = $2 AND doctor_id = $3`,
      [uuid(ownerUserId), uuid(clinicIdInput), uuid(doctorIdInput)],
    );
  }
}
