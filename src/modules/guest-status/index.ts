import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import {
  GuestAccessRejectedError,
  GuestAccessService,
  type GuestTarget,
} from '@/modules/guest-access';

const TERMINAL_GRACE_MS = 15 * 60 * 1_000;
const PROVISIONAL_UNCERTAINTY_MINUTES = 15;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_ENTRY_STATES = ['completed', 'cancelled', 'no_show'];
const TERMINAL_SESSION_STATES = ['closed', 'cancelled'];

export type GuestQueueStatusSnapshot =
  | {
      generatedAt: string;
      terminal: false;
      target: GuestTarget;
      publicDisplayLabel: string;
      queueState: string;
      patientsAhead: number | null;
      positionKind: 'live' | 'provisional';
      arrivalWindow: {
        earliestAt: string;
        latestAt: string;
        uncertaintyMinutes: number;
        basis: 'session_start_plus_declared_delay';
      } | null;
      session: {
        status: string;
        declaredDelayMinutes: number | null;
        delayVersion: number;
        queueOrderVersion: number;
      };
    }
  | {
      generatedAt: string;
      terminal: true;
      finalStatus: string;
    };

function parseBearer(
  bearer: string,
): { credentialId: string; secret: string } | null {
  const separator = bearer.indexOf('.');
  if (separator <= 0 || separator === bearer.length - 1) return null;
  const credentialId = bearer.slice(0, separator);
  const secret = bearer.slice(separator + 1);
  if (!UUID_PATTERN.test(credentialId) || !secret) return null;
  return { credentialId, secret };
}

function verifierMatches(storedVerifier: string, secret: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(storedVerifier)) return false;
  const stored = Buffer.from(storedVerifier, 'hex');
  const candidate = Buffer.from(
    createHash('sha256').update(secret, 'utf8').digest('hex'),
    'hex',
  );
  return (
    stored.length === candidate.length && timingSafeEqual(stored, candidate)
  );
}

function provisionalArrivalWindow(
  now: Date,
  sessionStartsAt: Date,
  declaredDelayMinutes: number | null,
) {
  const declaredDelayMs = Math.max(0, declaredDelayMinutes ?? 0) * 60_000;
  const estimatedAtMs = Math.max(
    now.getTime(),
    sessionStartsAt.getTime() + declaredDelayMs,
  );
  const uncertaintyMs = PROVISIONAL_UNCERTAINTY_MINUTES * 60_000;
  return {
    earliestAt: new Date(
      Math.max(now.getTime(), estimatedAtMs - uncertaintyMs),
    ).toISOString(),
    latestAt: new Date(estimatedAtMs + uncertaintyMs).toISOString(),
    uncertaintyMinutes: PROVISIONAL_UNCERTAINTY_MINUTES,
    basis: 'session_start_plus_declared_delay' as const,
  };
}

/** Read-only, credential-free guest projection for one authorized queue target. */
export class GuestStatusService {
  constructor(
    private readonly pool: Pool,
    private readonly guestAccess = new GuestAccessService(pool),
  ) {}

  async getSnapshot(
    bearer: string,
    now = new Date(),
  ): Promise<GuestQueueStatusSnapshot> {
    try {
      const target = await this.guestAccess.authorize(bearer, undefined, now);
      return await this.getActiveSnapshot(target, now);
    } catch (error) {
      if (!(error instanceof GuestAccessRejectedError)) throw error;
      return this.getTerminalSummary(bearer, now);
    }
  }

  private async getActiveSnapshot(
    target: GuestTarget,
    now: Date,
  ): Promise<GuestQueueStatusSnapshot> {
    const result = await this.pool.query<{
      public_display_label: string;
      queue_state: string;
      service_position: string;
      session_status: string;
      session_starts_at: Date;
      declared_delay_minutes: number | null;
      delay_version: number;
      queue_order_version: string;
    }>(
      `WITH ordered AS (
         SELECT entry.id,
                entry.public_display_label,
                entry.state::text AS queue_state,
                row_number() OVER (
                  ORDER BY
                    CASE entry.state
                      WHEN 'in_consultation' THEN 0
                      WHEN 'called' THEN 0
                      WHEN 'checked_in' THEN 1
                      WHEN 'waiting' THEN 2
                      ELSE 3
                    END,
                    CASE WHEN entry.priority_order IS NULL THEN 1 ELSE 0 END,
                    entry.priority_order NULLS LAST,
                    entry.eligibility_order NULLS LAST,
                    entry.registration_order,
                    entry.id
                ) AS service_position
           FROM queue_entries entry
          WHERE entry.clinic_id=$1
            AND entry.session_id=$2
            AND entry.state IN ('waiting','checked_in','called','in_consultation')
       )
       SELECT ordered.public_display_label,
              ordered.queue_state,
              ordered.service_position,
              session.status::text AS session_status,
              session.starts_at AS session_starts_at,
              session.declared_delay_minutes,
              session.delay_version,
              session.queue_order_version
         FROM ordered
         JOIN consultation_sessions session
           ON session.id=$2 AND session.clinic_id=$1
         JOIN guest_credentials credential
           ON credential.queue_entry_id=$3
          AND credential.session_id=$2
          AND credential.clinic_id=$1
          AND credential.revoked_at IS NULL
          AND credential.expires_at>$4
        WHERE ordered.id=$3
          AND session.status IN ('planned','open','paused')`,
      [target.clinicId, target.sessionId, target.queueEntryId, now],
    );
    const row = result.rows[0];
    if (!row) throw new GuestAccessRejectedError();

    const livePosition = row.queue_state !== 'waiting';
    return {
      generatedAt: now.toISOString(),
      terminal: false,
      target,
      publicDisplayLabel: row.public_display_label,
      queueState: row.queue_state,
      patientsAhead: livePosition
        ? Math.max(0, Number(row.service_position) - 1)
        : null,
      positionKind: livePosition ? 'live' : 'provisional',
      arrivalWindow: livePosition
        ? null
        : provisionalArrivalWindow(
            now,
            row.session_starts_at,
            row.declared_delay_minutes,
          ),
      session: {
        status: row.session_status,
        declaredDelayMinutes: row.declared_delay_minutes,
        delayVersion: row.delay_version,
        queueOrderVersion: Number(row.queue_order_version),
      },
    };
  }

  private async getTerminalSummary(
    bearer: string,
    now: Date,
  ): Promise<GuestQueueStatusSnapshot> {
    const parsed = parseBearer(bearer);
    if (!parsed) throw new GuestAccessRejectedError();

    const result = await this.pool.query<{
      bearer_verifier: string;
      expires_at: Date;
      revoked_at: Date | null;
      entry_state: string;
      entry_updated_at: Date;
      completed_at: Date | null;
      session_status: string;
      session_closed_at: Date | null;
      session_updated_at: Date;
    }>(
      `SELECT credential.bearer_verifier,credential.expires_at,credential.revoked_at,
              entry.state::text AS entry_state,entry.updated_at AS entry_updated_at,
              entry.completed_at,
              session.status::text AS session_status,session.closed_at AS session_closed_at,
              session.updated_at AS session_updated_at
         FROM guest_credentials credential
         JOIN queue_entries entry ON entry.id=credential.queue_entry_id
           AND entry.clinic_id=credential.clinic_id
           AND entry.session_id=credential.session_id
         JOIN consultation_sessions session ON session.id=credential.session_id
           AND session.clinic_id=credential.clinic_id
        WHERE credential.id=$1`,
      [parsed.credentialId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.revoked_at ||
      row.expires_at <= now ||
      !verifierMatches(row.bearer_verifier, parsed.secret)
    )
      throw new GuestAccessRejectedError();

    const entryTerminal = TERMINAL_ENTRY_STATES.includes(row.entry_state);
    const sessionTerminal = TERMINAL_SESSION_STATES.includes(
      row.session_status,
    );
    if (!entryTerminal && !sessionTerminal)
      throw new GuestAccessRejectedError();

    const terminalAt = entryTerminal
      ? (row.completed_at ?? row.entry_updated_at)
      : (row.session_closed_at ?? row.session_updated_at);
    if (now.getTime() - terminalAt.getTime() > TERMINAL_GRACE_MS)
      throw new GuestAccessRejectedError();

    return {
      generatedAt: now.toISOString(),
      terminal: true,
      finalStatus: entryTerminal ? row.entry_state : row.session_status,
    };
  }
}
