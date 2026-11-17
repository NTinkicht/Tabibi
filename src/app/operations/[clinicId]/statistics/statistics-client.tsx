'use client';

import Link from 'next/link';
import './statistics.css';
import { Button } from '@/app/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultWindow,
  isValidWindow,
  toStatisticsView,
  type StatisticsView,
} from './statistics-model';

type Locale = 'ar' | 'fr';
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; view: StatisticsView };

const copy = {
  fr: {
    title: 'Statistiques de la clinique',
    back: 'Retour à l’accueil',
    language: 'Langue',
    from: 'Du',
    to: 'Au',
    apply: 'Afficher',
    invalid: 'Choisissez une période valide de 31 jours au plus.',
    loading: 'Chargement des statistiques…',
    error: 'Impossible de charger les statistiques. Veuillez réessayer.',
    empty: 'Aucune séance sur cette période.',
    totals: 'Totaux de la période',
    sessions: 'Séances',
    completed: 'Terminées',
    noShow: 'Absences',
    cancelled: 'Annulées',
    opened: 'Séances ouvertes',
    late: 'Ouvertures tardives',
    doctors: 'Par médecin',
    doctor: 'Médecin',
    avgConsult: 'Durée moyenne (min)',
    avgDelay: 'Retard moyen (min)',
    withheld: 'Non affiché',
    trend: 'Retards par jour',
    date: 'Date',
    note: 'Statistiques opérationnelles uniquement, sans donnée clinique. Les moyennes ne sont pas affichées quand l’échantillon est trop petit.',
  },
  ar: {
    title: 'إحصاءات العيادة',
    back: 'العودة إلى الاستقبال',
    language: 'اللغة',
    from: 'من',
    to: 'إلى',
    apply: 'عرض',
    invalid: 'اختر فترة صحيحة لا تتجاوز 31 يومًا.',
    loading: 'جارٍ تحميل الإحصاءات…',
    error: 'تعذّر تحميل الإحصاءات. حاول مرة أخرى.',
    empty: 'لا توجد جلسات في هذه الفترة.',
    totals: 'إجمالي الفترة',
    sessions: 'الجلسات',
    completed: 'المكتملة',
    noShow: 'الغياب',
    cancelled: 'الملغاة',
    opened: 'الجلسات المفتوحة',
    late: 'الافتتاحات المتأخرة',
    doctors: 'حسب الطبيب',
    doctor: 'الطبيب',
    avgConsult: 'متوسط مدة الاستشارة (د)',
    avgDelay: 'متوسط التأخر (د)',
    withheld: 'غير معروض',
    trend: 'التأخر حسب اليوم',
    date: 'التاريخ',
    note: 'إحصاءات تشغيلية فقط دون أي بيانات طبية. لا تُعرض المتوسطات عندما تكون العينة صغيرة.',
  },
} as const;

export function StatisticsClient({
  clinicId,
  initialLocale,
}: {
  clinicId: string;
  initialLocale: Locale;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [window_, setWindow] = useState(() => defaultWindow(new Date()));
  const [applied, setApplied] = useState(window_);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const requestId = useRef(0);
  const t = copy[locale];
  const valid = isValidWindow(window_.from, window_.to);

  const apply = useCallback(() => {
    if (!valid) return;
    setState({ kind: 'loading' });
    setApplied({ ...window_ });
  }, [valid, window_]);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++requestId.current;
    void (async () => {
      try {
        const query = new URLSearchParams({
          from: applied.from,
          to: applied.to,
        });
        const response = await fetch(
          `/api/clinics/${encodeURIComponent(clinicId)}/statistics?${query}`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('Rejected');
        const view = toStatisticsView(await response.json());
        if (current === requestId.current && !controller.signal.aborted)
          setState({ kind: 'ready', view });
      } catch {
        if (current === requestId.current && !controller.signal.aborted)
          setState({ kind: 'error' });
      }
    })();
    return () => {
      controller.abort();
      requestId.current += 1;
    };
  }, [clinicId, applied]);

  const minutes = (seconds: number | null) =>
    seconds === null ? t.withheld : String(Math.round(seconds / 60));
  const delay = (value: number | null) =>
    value === null ? t.withheld : String(Math.round(value));

  return (
    <main className="st" lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="st-header">
        <Link
          href={`/operations/${encodeURIComponent(clinicId)}?locale=${locale}`}
        >
          {t.back}
        </Link>
        <div className="tb-segmented" role="group" aria-label={t.language}>
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
      <form
        className="st-window"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label>
          {t.from}
          <input
            type="date"
            value={window_.from}
            onChange={(event) =>
              setWindow({ ...window_, from: event.target.value })
            }
          />
        </label>
        <label>
          {t.to}
          <input
            type="date"
            value={window_.to}
            onChange={(event) =>
              setWindow({ ...window_, to: event.target.value })
            }
          />
        </label>
        <Button type="submit" disabled={!valid}>
          {t.apply}
        </Button>
        {!valid && (
          <span className="st-error" role="alert">
            {t.invalid}
          </span>
        )}
      </form>
      {state.kind === 'loading' && <p aria-live="polite">{t.loading}</p>}
      {state.kind === 'error' && (
        <p className="st-error" role="alert">
          {t.error}
        </p>
      )}
      {state.kind === 'ready' && state.view.totals.sessions === 0 && (
        <p>{t.empty}</p>
      )}
      {state.kind === 'ready' && state.view.totals.sessions > 0 && (
        <>
          <h2>{t.totals}</h2>
          <ul className="st-totals">
            {(
              [
                ['sessions', t.sessions],
                ['completed', t.completed],
                ['noShow', t.noShow],
                ['cancelled', t.cancelled],
                ['openedSessions', t.opened],
                ['lateStarts', t.late],
              ] as const
            ).map(([key, label]) => (
              <li key={key}>
                <strong>{state.view.totals[key]}</strong>
                {label}
              </li>
            ))}
          </ul>
          <h2>{t.doctors}</h2>
          <div className="st-scroll">
            <table className="st-table">
              <thead>
                <tr>
                  <th scope="col">{t.doctor}</th>
                  <th scope="col">{t.sessions}</th>
                  <th scope="col">{t.completed}</th>
                  <th scope="col">{t.noShow}</th>
                  <th scope="col">{t.cancelled}</th>
                  <th scope="col">{t.avgConsult}</th>
                  <th scope="col">{t.late}</th>
                  <th scope="col">{t.avgDelay}</th>
                </tr>
              </thead>
              <tbody>
                {state.view.doctors.map((row) => (
                  <tr key={row.doctorId}>
                    <th scope="row">{row.doctorName}</th>
                    <td>{row.sessions}</td>
                    <td>{row.completed}</td>
                    <td>{row.noShow}</td>
                    <td>{row.cancelled}</td>
                    <td>{minutes(row.averageConsultationSeconds)}</td>
                    <td>{row.lateStarts}</td>
                    <td>{delay(row.averageStartDelayMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>{t.trend}</h2>
          <div className="st-scroll">
            <table className="st-table">
              <thead>
                <tr>
                  <th scope="col">{t.date}</th>
                  <th scope="col">{t.sessions}</th>
                  <th scope="col">{t.opened}</th>
                  <th scope="col">{t.late}</th>
                </tr>
              </thead>
              <tbody>
                {state.view.delayTrend.map((row) => (
                  <tr key={row.date}>
                    <th scope="row">{row.date}</th>
                    <td>{row.sessions}</td>
                    <td>{row.opened}</td>
                    <td>{row.lateStarts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="st-note">{t.note}</p>
    </main>
  );
}
