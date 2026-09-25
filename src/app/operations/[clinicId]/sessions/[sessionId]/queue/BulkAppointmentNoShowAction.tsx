'use client';

import { useRef, useState } from 'react';
import { receptionistCopy } from '@/modules/localization/receptionist';

type Receipt = {
  sessionId: string;
  scannedAppointmentCount: number;
  resolvedAppointmentCount: number;
  arrivalGraceMinutes: number;
};

/**
 * Staff-only affordance: the API independently authenticates and determines
 * clinic-local grace eligibility; this UI never labels individual patients.
 */
export function BulkAppointmentNoShowAction({
  clinicId,
  sessionId,
  locale,
  enabled,
  onResolved,
}: {
  clinicId: string;
  sessionId: string;
  locale: 'ar' | 'fr';
  enabled: boolean;
  onResolved: () => Promise<void>;
}) {
  const t = receptionistCopy[locale];
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const retry = useRef<{ reason: string; key: string } | null>(null);

  async function resolve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = reason.trim();
    if (!enabled || pending || !normalized || normalized.length > 500) return;
    if (!window.confirm(t.bulkNoShowConfirm)) return;
    const key =
      retry.current?.reason === normalized
        ? retry.current.key
        : crypto.randomUUID();
    retry.current = { reason: normalized, key };
    setPending(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/clinics/${clinicId}/sessions/${sessionId}/appointments/bulk-no-show`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify({ reason: normalized }),
        },
      );
      if (!response.ok) {
        // A rejected conflict/authorization request is not a safe retryable
        // network failure. Clear the key; a connectivity error retains it.
        retry.current = null;
        throw new Error('bulk_no_show_rejected');
      }
      const payload = (await response.json()) as { receipt?: Receipt };
      const receipt = payload.receipt;
      if (
        !receipt ||
        receipt.sessionId !== sessionId ||
        !Number.isSafeInteger(receipt.resolvedAppointmentCount) ||
        receipt.resolvedAppointmentCount < 0 ||
        !Number.isSafeInteger(receipt.scannedAppointmentCount) ||
        receipt.scannedAppointmentCount < receipt.resolvedAppointmentCount ||
        !Number.isSafeInteger(receipt.arrivalGraceMinutes) ||
        receipt.arrivalGraceMinutes < 0
      ) {
        throw new Error('bulk_no_show_invalid_receipt');
      }
      retry.current = null;
      setReason('');
      setMessage(
        receipt.resolvedAppointmentCount === 0
          ? t.bulkNoShowNone
          : t.bulkNoShowResult.replace(
              '{count}',
              String(receipt.resolvedAppointmentCount),
            ),
      );
      // A failed refresh must not repeat an already committed mutation.
      await onResolved().catch(() => undefined);
    } catch {
      setMessage(t.bulkNoShowFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="createPanel" aria-label={t.bulkNoShowTitle}>
      <h2>{t.bulkNoShowTitle}</h2>
      <p>{t.bulkNoShowExplanation}</p>
      <form className="walkInForm" onSubmit={(event) => void resolve(event)}>
        <label>
          {t.bulkNoShowReason}
          <textarea
            name="bulkNoShowReason"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (retry.current?.reason !== event.target.value.trim()) {
                retry.current = null;
              }
            }}
            required
            maxLength={500}
            disabled={!enabled || pending}
          />
        </label>
        <button type="submit" disabled={!enabled || pending || !reason.trim()}>
          {pending ? t.pending : t.bulkNoShowSubmit}
        </button>
      </form>
      {!enabled && <p>{t.bulkNoShowUnavailable}</p>}
      {message && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
    </section>
  );
}
