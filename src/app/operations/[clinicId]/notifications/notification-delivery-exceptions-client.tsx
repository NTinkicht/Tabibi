'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

type Locale = 'ar' | 'fr';
type OutcomeCategory =
  | 'retry_timeout'
  | 'retries_exhausted'
  | 'provider_error'
  | 'unspecified';
type ExceptionView = {
  event: string;
  queueLabel: string | null;
  outcomeCategory: OutcomeCategory;
  attempts: number;
  maximum: number;
  at: string;
};

// A strict allow-list: `outcomeCode` is arbitrary provider-supplied text (up
// to 160 chars, no enum) persisted verbatim by NotificationDispatchService --
// it must never reach the DOM. Only these known, non-identifying codes map
// to a generic category; every other value (including any future/unknown
// provider code) falls back to 'unspecified'.
function categorizeOutcome(code: unknown): OutcomeCategory {
  if (code === 'claim_lease_expired') return 'retry_timeout';
  if (code === 'retry_exhausted') return 'retries_exhausted';
  if (code === 'provider_exception' || code === 'provider_indeterminate_result')
    return 'provider_error';
  return 'unspecified';
}
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; records: ExceptionView[] };

const copy = {
  fr: {
    title: 'Notifications non remises',
    back: 'Retour à la réception',
    refresh: 'Actualiser',
    loading: 'Chargement des notifications non remises…',
    error: 'Impossible de charger les notifications. Veuillez réessayer.',
    empty: 'Aucune notification en échec de livraison.',
    note: 'Une notification non remise ne signifie pas que le patient a été contacté. Si nécessaire, utilisez la procédure habituelle de contact manuel de la clinique.',
    attempt: 'Tentatives de livraison',
    at: 'Dernier échec',
    otherEvent: 'Notification de file',
    language: 'Langue',
    queueLabel: 'Passage',
    noQueueLabel: 'Passage non identifié',
    outcome: 'Motif',
    outcomes: {
      retry_timeout: 'Délai de traitement dépassé',
      retries_exhausted: 'Nombre maximal de tentatives atteint',
      provider_error: 'Erreur du fournisseur de notification',
      unspecified: 'Motif non précisé',
    },
    events: {
      queue_entry_created: 'Inscription à la file',
      estimate_changed_materially: 'Changement important du délai',
      turn_approaching: 'Tour proche',
      patient_called: 'Patient appelé',
      queue_entry_cancelled: 'Passage annulé',
    },
  },
  ar: {
    title: 'إشعارات تعذّر تسليمها',
    back: 'العودة إلى الاستقبال',
    refresh: 'تحديث',
    loading: 'جارٍ تحميل الإشعارات التي تعذّر تسليمها…',
    error: 'تعذّر تحميل الإشعارات. حاول مرة أخرى.',
    empty: 'لا توجد إشعارات تعذّر تسليمها.',
    note: 'عدم تسليم الإشعار لا يعني التواصل مع المريض. عند الحاجة، اتبع إجراءات العيادة المعتادة للتواصل اليدوي.',
    attempt: 'محاولات التسليم',
    at: 'آخر إخفاق',
    otherEvent: 'إشعار قائمة الانتظار',
    language: 'اللغة',
    queueLabel: 'الدور',
    noQueueLabel: 'دور غير محدد',
    outcome: 'السبب',
    outcomes: {
      retry_timeout: 'تجاوز مهلة المعالجة',
      retries_exhausted: 'بلغ الحد الأقصى لمحاولات الإرسال',
      provider_error: 'خطأ لدى مزوّد الإشعارات',
      unspecified: 'سبب غير محدد',
    },
    events: {
      queue_entry_created: 'التسجيل في قائمة الانتظار',
      estimate_changed_materially: 'تغيير مهم في وقت الانتظار',
      turn_approaching: 'اقتراب الدور',
      patient_called: 'استدعاء المريض',
      queue_entry_cancelled: 'إلغاء الدور',
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// An explicit UI allow-list: never put raw record/queue-entry IDs,
// patient/contact details, raw provider failure text, or notification
// payloads into the DOM. `queueLabel` is the same privacy-safe,
// receptionist-facing code already shown on the live queue board.
function toExceptionViews(payload: unknown): ExceptionView[] {
  if (!isRecord(payload) || !Array.isArray(payload.deadLetters))
    throw new Error('Invalid response');
  return payload.deadLetters.map((value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.eventKey !== 'string' ||
      typeof value.outcomeAt !== 'string' ||
      !Number.isSafeInteger(value.attemptCount) ||
      !Number.isSafeInteger(value.maxAttempts) ||
      (value.queueLabel !== null && typeof value.queueLabel !== 'string') ||
      (value.outcomeCode !== null && typeof value.outcomeCode !== 'string')
    )
      throw new Error('Invalid response');
    return {
      event: value.eventKey,
      queueLabel: value.queueLabel as string | null,
      outcomeCategory: categorizeOutcome(value.outcomeCode),
      attempts: value.attemptCount as number,
      maximum: value.maxAttempts as number,
      at: value.outcomeAt,
    };
  });
}

export function NotificationDeliveryExceptionsClient({
  clinicId,
  initialLocale,
}: {
  clinicId: string;
  initialLocale: Locale;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);
  const requestId = useRef(0);
  const t = copy[locale];

  const refresh = useCallback(() => {
    setState({ kind: 'loading' });
    setGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const currentRequest = ++requestId.current;
    void (async () => {
      try {
        const response = await fetch(
          `/api/clinics/${encodeURIComponent(clinicId)}/notifications/dead-letters?limit=100`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('Rejected');
        const records = toExceptionViews(await response.json());
        if (currentRequest === requestId.current && !controller.signal.aborted)
          setState({ kind: 'ready', records });
      } catch {
        if (currentRequest === requestId.current && !controller.signal.aborted)
          setState({ kind: 'error' });
      }
    })();
    return () => {
      controller.abort();
      requestId.current += 1;
    };
  }, [clinicId, generation]);

  return (
    <main lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header>
        <Link
          href={`/operations/${encodeURIComponent(clinicId)}?locale=${locale}`}
        >
          {t.back}
        </Link>
        <div role="group" aria-label={t.language}>
          <button
            type="button"
            lang="fr"
            onClick={() => setLocale('fr')}
            aria-pressed={locale === 'fr'}
          >
            Français
          </button>
          <button
            type="button"
            lang="ar"
            onClick={() => setLocale('ar')}
            aria-pressed={locale === 'ar'}
          >
            العربية
          </button>
        </div>
      </header>
      <h1>{t.title}</h1>
      <p>{t.note}</p>
      <button
        type="button"
        onClick={refresh}
        disabled={state.kind === 'loading'}
      >
        {t.refresh}
      </button>
      <section aria-busy={state.kind === 'loading'}>
        {state.kind === 'loading' ? <p role="status">{t.loading}</p> : null}
        {state.kind === 'error' ? <p role="alert">{t.error}</p> : null}
        {state.kind === 'ready' && state.records.length === 0 ? (
          <p role="status">{t.empty}</p>
        ) : null}
        {state.kind === 'ready' && state.records.length > 0 ? (
          <ul>
            {state.records.map((record, index) => {
              const eventLabel = Object.prototype.hasOwnProperty.call(
                t.events,
                record.event,
              )
                ? t.events[record.event as keyof typeof t.events]
                : t.otherEvent;
              const instant = new Date(record.at);
              return (
                <li key={index}>
                  <h2>{eventLabel}</h2>
                  <p>
                    {t.queueLabel}: {record.queueLabel ?? t.noQueueLabel}
                  </p>
                  <p>
                    {t.outcome}: {t.outcomes[record.outcomeCategory]}
                  </p>
                  <p>
                    {t.at}:{' '}
                    {Number.isFinite(instant.getTime())
                      ? instant.toLocaleString(locale === 'ar' ? 'ar' : 'fr')
                      : '—'}
                  </p>
                  <p>
                    {t.attempt}: {record.attempts} / {record.maximum}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
