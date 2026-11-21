// #971 (SECURITY.md Auditability): append-only audit of patient account
// credential events in patient_account_audit_events (migration 0062). Writers
// add the INSERT to the same SQL statement as the change (a data-modifying
// CTE), so an event exists exactly when its change committed. Metadata is
// limited to counts, times and the operator's host user: never tokens,
// verifiers, passwords, hashes or e-mail addresses.

export const PATIENT_ACCOUNT_AUDIT_ACTIONS = [
  'account_registered',
  'signed_in',
  'signed_out',
  'sessions_revoked',
  'account_locked',
  'password_changed',
  'password_reset_issued',
  'password_reset_redeemed',
] as const;
export type PatientAccountAuditAction =
  (typeof PATIENT_ACCOUNT_AUDIT_ACTIONS)[number];

/** Rows older than this are deleted by the retention sweep. */
export const PATIENT_ACCOUNT_AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

/** Who issued an operator-assisted action, as recorded in the audit log. */
export interface PatientAccountOperator {
  /** Name given with `--operator`; 1 to 120 characters, no control characters. */
  label: string;
  /** Operating-system user that ran the command, if known. */
  hostUser?: string;
}

const CONTROL = /[\p{Cc}\p{Cf}]/u;

export class PatientAccountOperatorError extends Error {
  constructor() {
    super(
      'An operator name (1-120 characters, no control characters) is required',
    );
    this.name = 'PatientAccountOperatorError';
  }
}

export function normalizeOperator(
  operator: PatientAccountOperator,
): PatientAccountOperator {
  const label = operator.label?.trim() ?? '';
  if (label.length < 1 || label.length > 120 || CONTROL.test(label))
    throw new PatientAccountOperatorError();
  const host = operator.hostUser?.trim();
  return {
    label,
    ...(host && host.length <= 120 && !CONTROL.test(host)
      ? { hostUser: host }
      : {}),
  };
}
