import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '@/platform/database/transaction';

export type NotificationIntentState = 'pending' | 'superseded';

export interface NotificationIntent {
  id: string;
  clinicId: string;
  queueEntryId: string | null;
  logicalTargetKey: string;
  eventKey: string;
  intentVersion: number;
  idempotencyKey: string;
  state: NotificationIntentState;
  payload: Record<string, unknown>;
  supersededById: string | null;
  createdAt: string;
  supersededAt: string | null;
}

export interface EnqueueNotificationIntentInput {
  clinicId: string;
  queueEntryId?: string | null;
  logicalTargetKey: string;
  eventKey: string;
  intentVersion: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export class NotificationOutboxValidationError extends Error {}
export class NotificationOutboxConflictError extends Error {}

interface IntentRow {
  id: string;
  clinic_id: string;
  queue_entry_id: string | null;
  logical_target_key: string;
  event_key: string;
  intent_version: string;
  idempotency_key: string;
  state: NotificationIntentState;
  payload: Record<string, unknown>;
  superseded_by_id: string | null;
  created_at: Date;
  superseded_at: Date | null;
}

const sensitivePayloadKey =
  /(password|passcode|secret|token|credential|diagnosis|medication|clinical|medical_record|access_key|api_key)/i;

function assertPrivacyMinimalPayload(value: unknown, path = 'payload'): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
    return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      assertPrivacyMinimalPayload(value[index], `${path}[${index}]`);
    return;
  }
  if (typeof value !== 'object')
    throw new NotificationOutboxValidationError(
      `${path} contains an unsupported value`,
    );

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (sensitivePayloadKey.test(key))
      throw new NotificationOutboxValidationError(
        `Notification payload may not persist sensitive field: ${key}`,
      );
    assertPrivacyMinimalPayload(child, `${path}.${key}`);
  }
}

function normalizeInput(input: EnqueueNotificationIntentInput) {
  const logicalTargetKey = input.logicalTargetKey.trim();
  const eventKey = input.eventKey.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const queueEntryId = input.queueEntryId?.trim() || null;

  if (!input.clinicId)
    throw new NotificationOutboxValidationError('Clinic id is required');
  if (!logicalTargetKey || logicalTargetKey.length > 160)
    throw new NotificationOutboxValidationError(
      'Logical target key is required and must be at most 160 characters',
    );
  if (!eventKey || eventKey.length > 120)
    throw new NotificationOutboxValidationError(
      'Event key is required and must be at most 120 characters',
    );
  if (!Number.isSafeInteger(input.intentVersion) || input.intentVersion <= 0)
    throw new NotificationOutboxValidationError(
      'Intent version must be a positive safe integer',
    );
  if (!idempotencyKey || idempotencyKey.length > 128)
    throw new NotificationOutboxValidationError(
      'Idempotency key is required and must be at most 128 characters',
    );
  if (
    !input.payload ||
    Array.isArray(input.payload) ||
    typeof input.payload !== 'object'
  )
    throw new NotificationOutboxValidationError(
      'Payload must be a JSON object',
    );
  assertPrivacyMinimalPayload(input.payload);

  return {
    ...input,
    queueEntryId,
    logicalTargetKey,
    eventKey,
    idempotencyKey,
  };
}

function toIntent(row: IntentRow): NotificationIntent {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    queueEntryId: row.queue_entry_id,
    logicalTargetKey: row.logical_target_key,
    eventKey: row.event_key,
    intentVersion: Number(row.intent_version),
    idempotencyKey: row.idempotency_key,
    state: row.state,
    payload: row.payload,
    supersededById: row.superseded_by_id,
    createdAt: row.created_at.toISOString(),
    supersededAt: row.superseded_at?.toISOString() ?? null,
  };
}

function sameIntent(row: IntentRow, input: ReturnType<typeof normalizeInput>) {
  return (
    row.logical_target_key === input.logicalTargetKey &&
    row.event_key === input.eventKey &&
    Number(row.intent_version) === input.intentVersion &&
    row.queue_entry_id === input.queueEntryId &&
    JSON.stringify(row.payload) === JSON.stringify(input.payload)
  );
}

async function loadByIdempotencyKey(
  client: PoolClient,
  clinicId: string,
  idempotencyKey: string,
): Promise<IntentRow | null> {
  const result = await client.query<IntentRow>(
    `SELECT id, clinic_id, queue_entry_id, logical_target_key, event_key,
            intent_version, idempotency_key, state, payload, superseded_by_id,
            created_at, superseded_at
       FROM notification_outbox
      WHERE clinic_id=$1 AND idempotency_key=$2`,
    [clinicId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

/** Durable provider-neutral notification intent store. */
export class NotificationOutboxRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(
    rawInput: EnqueueNotificationIntentInput,
  ): Promise<NotificationIntent> {
    const input = normalizeInput(rawInput);

    return inTransaction(this.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `notification-outbox:${input.clinicId}:${input.logicalTargetKey}:${input.eventKey}`,
        ],
      );

      const retry = await loadByIdempotencyKey(
        client,
        input.clinicId,
        input.idempotencyKey,
      );
      if (retry) {
        if (!sameIntent(retry, input))
          throw new NotificationOutboxConflictError(
            'Idempotency key was already used for a different notification intent',
          );
        return toIntent(retry);
      }

      const latest = await client.query<Pick<IntentRow, 'intent_version'>>(
        `SELECT intent_version
           FROM notification_outbox
          WHERE clinic_id=$1 AND logical_target_key=$2 AND event_key=$3
          ORDER BY intent_version DESC
          LIMIT 1
          FOR UPDATE`,
        [input.clinicId, input.logicalTargetKey, input.eventKey],
      );
      const latestVersion = latest.rows[0]
        ? Number(latest.rows[0].intent_version)
        : 0;
      if (input.intentVersion <= latestVersion)
        throw new NotificationOutboxConflictError(
          'Intent version must advance the latest persisted version for this target and event',
        );

      const id = randomUUID();
      const inserted = await client.query<IntentRow>(
        `INSERT INTO notification_outbox (
           id, clinic_id, queue_entry_id, logical_target_key, event_key,
           intent_version, idempotency_key, payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         RETURNING id, clinic_id, queue_entry_id, logical_target_key, event_key,
                   intent_version, idempotency_key, state, payload,
                   superseded_by_id, created_at, superseded_at`,
        [
          id,
          input.clinicId,
          input.queueEntryId,
          input.logicalTargetKey,
          input.eventKey,
          input.intentVersion,
          input.idempotencyKey,
          JSON.stringify(input.payload),
        ],
      );

      await client.query(
        `UPDATE notification_outbox
            SET state='superseded', superseded_by_id=$4, superseded_at=now()
          WHERE clinic_id=$1
            AND logical_target_key=$2
            AND event_key=$3
            AND id<>$4
            AND state='pending'`,
        [input.clinicId, input.logicalTargetKey, input.eventKey, id],
      );

      const row = inserted.rows[0];
      if (!row)
        throw new NotificationOutboxConflictError(
          'Notification intent could not be persisted',
        );
      return toIntent(row);
    });
  }
}
