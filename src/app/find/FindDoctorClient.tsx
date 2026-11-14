'use client';

import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import { Button, Chip, SegmentedControl } from '@/app/ui';
import { SPECIALTIES } from '@/modules/clinic/specialties';
import { WILAYAS } from '@/modules/clinic/wilayas';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  type PublicClinic,
  type PublicLocale,
  clinicLocation,
  doctorSpecialties,
  parsePublicClinics,
} from '../public-discovery-clinics';
import { findCopy } from './find-copy';
import {
  type BookableClinic,
  type BookableDoctor,
  EMPTY_FILTERS,
  type FindFilters,
  type FindMode,
  bookingPath,
  earliestSession,
  findEndpoint,
  parseBookableClinics,
  sessionDayLabel,
  sessionHoursLabel,
} from './find-model';

type Results = {
  clinics: (BookableClinic | PublicClinic)[];
  hasMore: boolean;
  page: number;
};
type Load = 'loading' | 'ready' | 'error';

function subscribe(onChange: () => void) {
  window.addEventListener('languagechange', onChange);
  return () => window.removeEventListener('languagechange', onChange);
}
function browserLocale(): PublicLocale {
  return /^ar(?:[-_]|$)/i.test(navigator.language.trim()) ? 'ar' : 'fr';
}

async function fetchPage(
  mode: FindMode,
  filters: FindFilters,
  page: number,
  signal: AbortSignal,
): Promise<Results> {
  const response = await fetch(findEndpoint(mode, filters, page), {
    signal,
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error('unavailable');
  const body: unknown = await response.json();
  const clinics =
    mode === 'book' ? parseBookableClinics(body) : parsePublicClinics(body);
  if (
    clinics === null ||
    typeof body !== 'object' ||
    body === null ||
    !('hasMore' in body) ||
    typeof body.hasMore !== 'boolean'
  ) {
    throw new Error('invalid');
  }
  return { clinics, hasMore: body.hasMore, page };
}

export default function FindDoctorClient({
  initial,
}: {
  initial: BookableClinic[] | null;
}) {
  const detected = useSyncExternalStore<PublicLocale>(
    subscribe,
    browserLocale,
    () => 'fr',
  );
  const [chosen, setChosen] = useState<PublicLocale | null>(null);
  const locale = chosen ?? detected;
  const t = findCopy[locale];
  const [mode, setMode] = useState<FindMode>('book');
  const [filters, setFilters] = useState<FindFilters>(EMPTY_FILTERS);
  const [results, setResults] = useState<Results>({
    clinics: initial ?? [],
    hasMore: false,
    page: 1,
  });
  const [load, setLoad] = useState<Load>(
    initial === null ? 'loading' : 'ready',
  );
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<{
    clinic: BookableClinic;
    doctor: BookableDoctor;
  } | null>(null);
  // The server-rendered page is the unfiltered booking list; any change
  // (or a failed server render) loads from the API.
  const [useInitial, setUseInitial] = useState(initial !== null);

  useEffect(() => {
    if (useInitial) return;
    const controller = new AbortController();
    fetchPage(mode, filters, 1, controller.signal)
      .then((next) => {
        setResults(next);
        setLoad('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad('error');
      });
    return () => controller.abort();
  }, [mode, filters, retry, useInitial]);

  function change(next: { mode?: FindMode; filters?: FindFilters }) {
    setUseInitial(false);
    setLoad('loading');
    setSelected(null);
    if (next.mode) setMode(next.mode);
    if (next.filters) setFilters(next.filters);
  }

  async function loadMore() {
    try {
      const next = await fetchPage(
        mode,
        filters,
        results.page + 1,
        new AbortController().signal,
      );
      setResults((current) => ({
        ...next,
        clinics: [...current.clinics, ...next.clinics],
      }));
    } catch {
      setLoad('error');
    }
  }

  const languageOptions = [
    { value: 'all', label: t.languageAll },
    { value: 'ar', label: t.languageAr },
    { value: 'fr', label: t.languageFr },
  ];

  return (
    <main className="fd-page">
      <DocumentLocaleSync locale={locale} />
      <header className="fd-header">
        <h1>{t.title}</h1>
        <Button
          variant="soft"
          onClick={() => setChosen(locale === 'ar' ? 'fr' : 'ar')}
        >
          {locale === 'ar' ? 'Français' : 'العربية'}
        </Button>
      </header>

      {selected === null ? (
        <>
          <section className="fd-card" aria-label={t.title}>
            <label>
              {t.specialty}
              <select
                value={filters.specialty}
                onChange={(e) =>
                  change({ filters: { ...filters, specialty: e.target.value } })
                }
              >
                <option value="">{t.anySpecialty}</option>
                {SPECIALTIES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.labels[locale]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.wilaya}
              <select
                value={filters.wilaya}
                onChange={(e) =>
                  change({ filters: { ...filters, wilaya: e.target.value } })
                }
              >
                <option value="">{t.anyWilaya}</option>
                {WILAYAS.map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.code} · {w.labels[locale]}
                  </option>
                ))}
              </select>
            </label>
            <SegmentedControl
              label={t.language}
              options={languageOptions}
              value={filters.language}
              onChange={(value) =>
                change({
                  filters: {
                    ...filters,
                    language: value === 'ar' || value === 'fr' ? value : 'all',
                  },
                })
              }
            />
            <SegmentedControl
              label={t.mode}
              options={[
                { value: 'book', label: t.modeBook },
                { value: 'directory', label: t.modeDirectory },
              ]}
              value={mode}
              onChange={(value) =>
                change({ mode: value === 'directory' ? 'directory' : 'book' })
              }
            />
          </section>

          <p role="status" className="fd-count">
            {load === 'ready' ? t.count(results.clinics.length) : t.loading}
          </p>
          {mode === 'directory' && <p className="fd-hint">{t.directoryHint}</p>}
          {load === 'error' && (
            <p role="alert">
              {t.error}{' '}
              <Button
                variant="secondary"
                onClick={() => {
                  setLoad('loading');
                  setRetry(retry + 1);
                }}
              >
                {t.retry}
              </Button>
            </p>
          )}
          {load === 'ready' && results.clinics.length === 0 && <p>{t.empty}</p>}
          <ul className="fd-list">
            {results.clinics.map((clinic, index) => (
              <li key={`${clinic.name}-${index}`} className="fd-card">
                <h2>{clinic.name}</h2>
                <p>{clinicLocation(clinic, locale)}</p>
                <ul className="fd-doctors">
                  {clinic.doctors.map((doctor, doctorIndex) => {
                    const bookable = 'sessions' in doctor ? doctor : null;
                    const first = bookable ? earliestSession(bookable) : null;
                    return (
                      <li key={`${doctor.displayName}-${doctorIndex}`}>
                        <strong>{doctor.displayName}</strong>
                        {doctor.specialtyCodes.length > 0 && (
                          <Chip>{doctorSpecialties(doctor, locale)}</Chip>
                        )}
                        {bookable && first && 'sessions' in doctor && (
                          <>
                            <p>
                              {t.nextSession} : {sessionDayLabel(first, locale)}{' '}
                              {sessionHoursLabel(first, locale)}
                            </p>
                            <Button
                              onClick={() =>
                                setSelected({
                                  clinic: clinic as BookableClinic,
                                  doctor: bookable,
                                })
                              }
                            >
                              {t.viewSessions}
                            </Button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          {results.hasMore && load === 'ready' && (
            <Button variant="secondary" onClick={() => void loadMore()}>
              {t.more}
            </Button>
          )}
        </>
      ) : (
        <section className="fd-card">
          <Button variant="soft" onClick={() => setSelected(null)}>
            <span aria-hidden="true">{locale === 'ar' ? '→' : '←'}</span>{' '}
            {t.back}
          </Button>
          <h2>{selected.doctor.displayName}</h2>
          <p>
            {doctorSpecialties(selected.doctor, locale)} ·{' '}
            {selected.clinic.name}
          </p>
          <h3>{t.sessions}</h3>
          <ul className="fd-list">
            {selected.doctor.sessions.map((session) => (
              <li key={session.selectionReference} className="fd-session">
                <span>
                  {sessionDayLabel(session, locale)}{' '}
                  {sessionHoursLabel(session, locale)}
                </span>
                <a
                  className="tb-button tb-button--primary"
                  href={bookingPath(session)}
                >
                  {t.book}
                </a>
              </li>
            ))}
          </ul>
          <p className="fd-hint">{t.sessionNote}</p>
        </section>
      )}
      <footer className="fd-hint">{t.footer}</footer>
    </main>
  );
}
