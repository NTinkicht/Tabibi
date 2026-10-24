import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAuditEvent } from '@/modules/audit';
import { type ClinicScope, requireClinicRole } from '@/modules/identity';
import { inTransaction } from '@/platform/database/transaction';

// TAB-P0-02 (#651): clinic-scoped consultation types and nominal durations.
// This slice is the catalogue only; templates, sessions, bookings and ETA do
// not reference consultation types yet.

export interface ConsultationType {
  id: string;
  clinicId: string;
  code: string;
  label: string;
  nominalDurationMinutes: number;
  active: boolean;
}

interface ConsultationTypeRow {
  id: string;
  clinic_id: string;
  code: string;
  label: string;
  nominal_duration_minutes: number;
  active: boolean;
}

const COLUMNS = 'id, clinic_id, code, label, nominal_duration_minutes, active';

export const CONSULTATION_DURATION_MIN_MINUTES = 5;
export const CONSULTATION_DURATION_MAX_MINUTES = 240;
const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const LABEL_MAX_LENGTH = 80;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The same code already exists in this clinic. Codes are unique per clinic
// only, so another clinic may use the same code.
export class ConsultationTypeConflictError extends Error {
  constructor() {
    super('A consultation type with this code already exists in the clinic');
    this.name = 'ConsultationTypeConflictError';
  }
}

// An unknown id and another clinic's id are reported with the same error, so
// the scoped lookup is not a cross-tenant existence oracle.
export class ConsultationTypeNotFoundError extends Error {
  constructor() {
    super('Consultation type not found');
    this.name = 'ConsultationTypeNotFoundError';
  }
}

function fromRow(row: ConsultationTypeRow): ConsultationType {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    code: row.code,
    label: row.label,
    nominalDurationMinutes: row.nominal_duration_minutes,
    active: row.active,
  };
}

function normalizeInput(input: {
  code: unknown;
  label: unknown;
  nominalDurationMinutes: unknown;
}): { code: string; label: string; nominalDurationMinutes: number } {
  if (typeof input.code !== 'string' || !CODE_PATTERN.test(input.code))
    throw new TypeError(
      'code must be 1-48 lowercase letters, digits, "-" or "_", starting with a letter or digit',
    );
  if (typeof input.label !== 'string')
    throw new TypeError('label must be a string');
  const label = input.label.trim();
  if (
    label.length < 1 ||
    label.length > LABEL_MAX_LENGTH ||
    CONTROL_CHARACTERS.test(label)
  )
    throw new TypeError(
      `label must be 1-${LABEL_MAX_LENGTH} characters without control characters`,
    );
  const minutes = input.nominalDurationMinutes;
  if (
    typeof minutes !== 'number' ||
    !Number.isInteger(minutes) ||
    minutes < CONSULTATION_DURATION_MIN_MINUTES ||
    minutes > CONSULTATION_DURATION_MAX_MINUTES
  )
    throw new TypeError(
      `nominalDurationMinutes must be an integer from ${CONSULTATION_DURATION_MIN_MINUTES} to ${CONSULTATION_DURATION_MAX_MINUTES}`,
    );
  return { code: input.code, label, nominalDurationMinutes: minutes };
}

function isDuplicateCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'consultation_types_clinic_id_code_key'
  );
}

export class ConsultationTypeService {
  constructor(private readonly pool: Pool) {}

  /** Lists the clinic's consultation types for any clinic member. */
  async list(
    scope: ClinicScope,
    options: { includeInactive?: boolean } = {},
  ): Promise<ConsultationType[]> {
    await requireClinicRole(this.pool, scope, [
      'doctor',
      'receptionist',
      'clinic_admin',
    ]);
    const result = await this.pool.query<ConsultationTypeRow>(
      `SELECT ${COLUMNS} FROM consultation_types
        WHERE clinic_id = $1 AND ($2::boolean OR active)
        ORDER BY code`,
      [scope.clinicId, options.includeInactive === true],
    );
    return result.rows.map(fromRow);
  }

  /** Creates an active consultation type; clinic admins only. */
  async create(
    scope: ClinicScope,
    input: { code: string; label: string; nominalDurationMinutes: number },
  ): Promise<ConsultationType> {
    const value = normalizeInput(input);
    return inTransaction(this.pool, async (client) => {
      await requireClinicRole(client, scope, ['clinic_admin']);
      const id = randomUUID();
      let row: ConsultationTypeRow;
      try {
        const result = await client.query<ConsultationTypeRow>(
          `INSERT INTO consultation_types
             (id, clinic_id, code, label, nominal_duration_minutes)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${COLUMNS}`,
          [
            id,
            scope.clinicId,
            value.code,
            value.label,
            value.nominalDurationMinutes,
          ],
        );
        row = result.rows[0]!;
      } catch (error) {
        if (isDuplicateCode(error)) throw new ConsultationTypeConflictError();
        throw error;
      }
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'clinic',
        entityId: scope.clinicId,
        action: 'consultation_type.created',
        metadata: {
          consultationTypeId: id,
          code: value.code,
          nominalDurationMinutes: value.nominalDurationMinutes,
        },
      });
      return fromRow(row);
    });
  }

  /**
   * Retires or restores a consultation type; clinic admins only. Setting the
   * current state is an idempotent no-op without audit.
   */
  async setActive(
    scope: ClinicScope,
    input: { consultationTypeId: string; active: boolean },
  ): Promise<ConsultationType> {
    if (typeof input.active !== 'boolean')
      throw new TypeError('active must be a boolean');
    return inTransaction(this.pool, async (client) => {
      // Deny before the lookup so its result is only observable to admins.
      await requireClinicRole(client, scope, ['clinic_admin']);
      if (!UUID_TEXT.test(input.consultationTypeId))
        throw new ConsultationTypeNotFoundError();
      const current = await client.query<ConsultationTypeRow>(
        `SELECT ${COLUMNS} FROM consultation_types
          WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
        [input.consultationTypeId, scope.clinicId],
      );
      const row = current.rows[0];
      if (!row) throw new ConsultationTypeNotFoundError();
      if (row.active === input.active) return fromRow(row);
      const updated = await client.query<ConsultationTypeRow>(
        `UPDATE consultation_types SET active = $3, updated_at = now()
          WHERE id = $1 AND clinic_id = $2
          RETURNING ${COLUMNS}`,
        [row.id, scope.clinicId, input.active],
      );
      await appendAuditEvent(client, {
        ...scope,
        entityType: 'clinic',
        entityId: scope.clinicId,
        action: input.active
          ? 'consultation_type.activated'
          : 'consultation_type.deactivated',
        metadata: { consultationTypeId: row.id, code: row.code },
      });
      return fromRow(updated.rows[0]!);
    });
  }
}
