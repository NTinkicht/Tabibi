import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type AccountDependentStatus = 'active' | 'archived';

export interface AccountOwnerScope {
  ownerUserId: string;
}

export interface AccountDependent {
  id: string;
  displayName: string;
  status: AccountDependentStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateAccountDependentInput {
  displayName: string;
}

export interface UpdateAccountDependentInput {
  displayName: string;
}

export interface ListAccountDependentsOptions {
  includeArchived?: boolean;
}

export class AccountDependentValidationError extends Error {
  constructor(message = 'Dependent input is invalid') {
    super(message);
    this.name = 'AccountDependentValidationError';
  }
}

export class AccountDependentNotFoundError extends Error {
  constructor() {
    super('Dependent not found');
    this.name = 'AccountDependentNotFoundError';
  }
}

type DependentRow = {
  id: string;
  owner_user_id: string;
  display_name: string;
  status: AccountDependentStatus;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

const dependentColumns = `id, owner_user_id, display_name, status,
  created_at, updated_at, archived_at`;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unsafeControlPattern = /[\p{Cc}\p{Cf}]/u;

function normalizeOwnerScope(scope: AccountOwnerScope): string {
  const ownerUserId = scope.ownerUserId.trim();
  if (!uuidPattern.test(ownerUserId))
    throw new AccountDependentValidationError(
      'Authenticated owner scope is invalid',
    );
  return ownerUserId;
}

export function normalizeDependentDisplayName(raw: string): string {
  if (typeof raw !== 'string') throw new AccountDependentValidationError();
  const normalized = raw.normalize('NFC').trim();
  const codePointLength = Array.from(normalized).length;
  if (
    codePointLength < 1 ||
    codePointLength > 160 ||
    unsafeControlPattern.test(normalized)
  )
    throw new AccountDependentValidationError();
  return normalized;
}

function normalizeDependentId(id: string): string {
  const normalized = id.trim();
  if (!uuidPattern.test(normalized)) throw new AccountDependentNotFoundError();
  return normalized;
}

function toDependent(row: DependentRow): AccountDependent {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
  };
}

/**
 * Server-side dependent API. The caller supplies only a trusted authenticated
 * owner scope; owner identifiers are never accepted from dependent input or
 * serialized in results.
 */
export class AccountDependentService {
  constructor(private readonly pool: Pool) {}

  async create(
    scope: AccountOwnerScope,
    input: CreateAccountDependentInput,
  ): Promise<AccountDependent> {
    const ownerUserId = normalizeOwnerScope(scope);
    const displayName = normalizeDependentDisplayName(input.displayName);
    const result = await this.pool.query<DependentRow>(
      `INSERT INTO patient_dependents (id, owner_user_id, display_name)
       VALUES ($1,$2,$3)
       RETURNING ${dependentColumns}`,
      [randomUUID(), ownerUserId, displayName],
    );
    return toDependent(result.rows[0]!);
  }

  async list(
    scope: AccountOwnerScope,
    options: ListAccountDependentsOptions = {},
  ): Promise<AccountDependent[]> {
    const ownerUserId = normalizeOwnerScope(scope);
    const result = await this.pool.query<DependentRow>(
      `SELECT ${dependentColumns}
         FROM patient_dependents
        WHERE owner_user_id=$1
          AND ($2::boolean OR status='active')
        ORDER BY created_at, id`,
      [ownerUserId, options.includeArchived === true],
    );
    return result.rows.map(toDependent);
  }

  async get(
    scope: AccountOwnerScope,
    dependentId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<AccountDependent> {
    const ownerUserId = normalizeOwnerScope(scope);
    const id = normalizeDependentId(dependentId);
    const result = await this.pool.query<DependentRow>(
      `SELECT ${dependentColumns}
         FROM patient_dependents
        WHERE id=$1 AND owner_user_id=$2
          AND ($3::boolean OR status='active')`,
      [id, ownerUserId, options.includeArchived === true],
    );
    const row = result.rows[0];
    if (!row) throw new AccountDependentNotFoundError();
    return toDependent(row);
  }

  async update(
    scope: AccountOwnerScope,
    dependentId: string,
    input: UpdateAccountDependentInput,
  ): Promise<AccountDependent> {
    const ownerUserId = normalizeOwnerScope(scope);
    const id = normalizeDependentId(dependentId);
    const displayName = normalizeDependentDisplayName(input.displayName);
    const result = await this.pool.query<DependentRow>(
      `UPDATE patient_dependents
          SET display_name=$3, updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND status='active'
        RETURNING ${dependentColumns}`,
      [id, ownerUserId, displayName],
    );
    const row = result.rows[0];
    if (!row) throw new AccountDependentNotFoundError();
    return toDependent(row);
  }

  async archive(
    scope: AccountOwnerScope,
    dependentId: string,
  ): Promise<AccountDependent> {
    const ownerUserId = normalizeOwnerScope(scope);
    const id = normalizeDependentId(dependentId);
    const updated = await this.pool.query<DependentRow>(
      `UPDATE patient_dependents
          SET status='archived', archived_at=now(), updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND status='active'
        RETURNING ${dependentColumns}`,
      [id, ownerUserId],
    );
    if (updated.rows[0]) return toDependent(updated.rows[0]);

    const existing = await this.pool.query<DependentRow>(
      `SELECT ${dependentColumns}
         FROM patient_dependents
        WHERE id=$1 AND owner_user_id=$2 AND status='archived'`,
      [id, ownerUserId],
    );
    if (!existing.rows[0]) throw new AccountDependentNotFoundError();
    return toDependent(existing.rows[0]);
  }

  async getActiveForOperation(
    scope: AccountOwnerScope,
    dependentId: string,
  ): Promise<AccountDependent> {
    return this.get(scope, dependentId);
  }
}
