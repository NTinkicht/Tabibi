'use client';

import { useEffect, useState } from 'react';

type Locale = 'ar' | 'fr';
export type PublicClinic = {
  name: string;
  defaultLocale: Locale;
  enabledLocales: Locale[];
  doctors: { displayName: string }[];
};
type LoadState = 'loading' | 'ready' | 'error';
const REFRESH_TIMEOUT_MS = 5_000;

const copy = {
  fr: {
    intro: 'Trouvez votre clinique',
    description:
      'Découvrez les cliniques et les médecins disponibles sur Tabibi.',
    directory: 'Cliniques',
    searchLabel: 'Rechercher une clinique ou un médecin',
    searchPlaceholder: 'Nom de la clinique ou du médecin',
    clearSearch: 'Effacer la recherche',
    searchCount: (count: number) =>
      `${count} clinique${count === 1 ? '' : 's'} trouvée${count === 1 ? '' : 's'}.`,
    noSearchMatches:
      'Aucune clinique ni aucun médecin ne correspond à votre recherche.',
    refresh: 'Actualiser',
    refreshed: (count: number) =>
      `Répertoire actualisé : ${count} clinique${count === 1 ? '' : 's'}.`,
    doctors: 'Médecins',
    noDoctors: 'Aucun médecin affiché pour le moment.',
    languages: 'Langues',
    empty: 'Aucune clinique à afficher pour le moment.',
    error: 'Le répertoire est momentanément indisponible.',
    retry: 'Réessayer',
    loading: 'Chargement des cliniques…',
    note: 'Les disponibilités et la réservation seront accessibles depuis un parcours sécurisé.',
  },
  ar: {
    intro: 'ابحث عن عيادتك',
    description: 'تعرّف على العيادات والأطباء المعروضين على طبيبي.',
    directory: 'العيادات',
    searchLabel: 'ابحث عن عيادة أو طبيب',
    searchPlaceholder: 'اسم العيادة أو الطبيب',
    clearSearch: 'مسح البحث',
    searchCount: (count: number) => `نتائج البحث: ${count} عيادة.`,
    noSearchMatches: 'لا توجد عيادات أو أطباء يطابقون بحثك.',
    refresh: 'تحديث',
    refreshed: (count: number) => `تم تحديث الدليل: ${count} عيادة.`,
    doctors: 'الأطباء',
    noDoctors: 'لا يوجد أطباء معروضون حاليًا.',
    languages: 'اللغات',
    empty: 'لا توجد عيادات معروضة حاليًا.',
    error: 'دليل العيادات غير متاح مؤقتًا.',
    retry: 'إعادة المحاولة',
    loading: 'جارٍ تحميل العيادات…',
    note: 'ستتاح المواعيد والحجوزات عبر مسار آمن مخصص لها.',
  },
} as const;

// Compare public display names only; ignore accents and Arabic vowel marks
// without modifying the visible clinic/doctor names.
function normalizeSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\u0640/g, '')
    .toLowerCase();
}

function parseClinics(value: unknown): PublicClinic[] | null {
  if (typeof value !== 'object' || value === null || !('clinics' in value)) {
    return null;
  }
  const clinics = value.clinics;
  if (!Array.isArray(clinics)) return null;
  const result: PublicClinic[] = [];
  for (const clinic of clinics) {
    if (
      typeof clinic !== 'object' ||
      clinic === null ||
      typeof clinic.name !== 'string' ||
      (clinic.defaultLocale !== 'ar' && clinic.defaultLocale !== 'fr') ||
      !Array.isArray(clinic.enabledLocales) ||
      !clinic.enabledLocales.every(
        (entry: unknown) => entry === 'ar' || entry === 'fr',
      ) ||
      !Array.isArray(clinic.doctors)
    ) {
      return null;
    }
    const doctors: { displayName: string }[] = [];
    for (const doctor of clinic.doctors) {
      if (
        typeof doctor !== 'object' ||
        doctor === null ||
        typeof doctor.displayName !== 'string'
      ) {
        return null;
      }
      doctors.push({ displayName: doctor.displayName });
    }
    result.push({
      name: clinic.name,
      defaultLocale: clinic.defaultLocale,
      enabledLocales: [...clinic.enabledLocales],
      doctors,
    });
  }
  return result;
}

export default function PublicDiscoveryLandingClient({
  initialClinics,
}: {
  initialClinics: PublicClinic[] | null;
}) {
  const [locale, setLocale] = useState<Locale>('fr');
  const [state, setState] = useState<LoadState>(
    initialClinics === null ? 'error' : 'ready',
  );
  const [clinics, setClinics] = useState<PublicClinic[]>(initialClinics ?? []);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [refreshCount, setRefreshCount] = useState<number | null>(null);
  const t = copy[locale];
  const query = normalizeSearch(search.trim());
  const matchingClinics = query
    ? clinics.filter(
        (clinic) =>
          normalizeSearch(clinic.name).includes(query) ||
          clinic.doctors.some((doctor) =>
            normalizeSearch(doctor.displayName).includes(query),
          ),
      )
    : clinics;

  useEffect(() => {
    if (retry === 0) return;
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => {
      controller.abort();
      setState('error');
    }, REFRESH_TIMEOUT_MS);
    async function load() {
      try {
        const response = await fetch('/api/public/discovery', {
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw new Error('Discovery unavailable');
        const result: unknown = await response.json();
        const publicClinics = parseClinics(result);
        if (publicClinics === null) throw new Error('Invalid discovery shape');
        if (controller.signal.aborted) return;
        setClinics(publicClinics);
        setRefreshCount(publicClinics.length);
        setState('ready');
      } catch {
        if (!controller.signal.aborted) setState('error');
      } finally {
        clearTimeout(deadlineTimer);
      }
    }
    void load();
    return () => {
      clearTimeout(deadlineTimer);
      controller.abort();
    };
  }, [retry]);

  const beginRefresh = () => {
    setRefreshCount(null);
    setState('loading');
    setRetry((value) => value + 1);
  };

  return (
    <main
      className="publicLanding"
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
    >
      <header className="publicHeader">
        <div>
          <span className="publicMark" aria-hidden="true">
            ✚
          </span>
          <h1>Tabibi</h1>
        </div>
        <nav className="publicLocales" aria-label="Langue / اللغة">
          <button
            type="button"
            lang="fr"
            aria-pressed={locale === 'fr'}
            onClick={() => setLocale('fr')}
          >
            Français
          </button>
          <button
            type="button"
            lang="ar"
            aria-pressed={locale === 'ar'}
            onClick={() => setLocale('ar')}
          >
            العربية
          </button>
        </nav>
      </header>

      <section className="publicHero">
        <p className="publicEyebrow">TABIBI</p>
        <h2>{t.intro}</h2>
        <p>{t.description}</p>
      </section>

      <section aria-labelledby="publicDirectoryTitle">
        <div className="publicDirectoryHeading">
          <h2 id="publicDirectoryTitle">{t.directory}</h2>
          <button
            className="publicRefresh"
            type="button"
            disabled={state === 'loading'}
            onClick={beginRefresh}
          >
            {t.refresh}
          </button>
        </div>
        {state === 'ready' && clinics.length > 0 && (
          <div className="publicSearch">
            <label htmlFor="publicClinicSearch">{t.searchLabel}</label>
            <div className="publicSearchControls">
              <input
                id="publicClinicSearch"
                type="search"
                autoComplete="off"
                maxLength={120}
                placeholder={t.searchPlaceholder}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search.length > 0 && (
                <button type="button" onClick={() => setSearch('')}>
                  {t.clearSearch}
                </button>
              )}
            </div>
            {query && (
              <p aria-live="polite" aria-atomic="true">
                {t.searchCount(matchingClinics.length)}
              </p>
            )}
          </div>
        )}
        <div aria-live="polite" aria-atomic="true">
          {state === 'loading' && <p role="status">{t.loading}</p>}
          {state === 'error' && (
            <div className="publicNotice" role="alert">
              <p>{t.error}</p>
              <button type="button" onClick={beginRefresh}>
                {t.retry}
              </button>
            </div>
          )}
          {state === 'ready' && refreshCount !== null && clinics.length > 0 && (
            <p role="status">{t.refreshed(refreshCount)}</p>
          )}
          {state === 'ready' && clinics.length === 0 && (
            <p className="publicNotice">{t.empty}</p>
          )}
        </div>
        {state === 'ready' &&
          clinics.length > 0 &&
          query &&
          matchingClinics.length === 0 && (
            <p className="publicNotice" role="status">
              {t.noSearchMatches}
            </p>
          )}
        {state === 'ready' && matchingClinics.length > 0 && (
          <div className="publicGrid">
            {matchingClinics.map((clinic, index) => (
              <article className="publicClinic" key={index}>
                <h3>{clinic.name}</h3>
                <p className="publicLanguages">
                  {t.languages}:{' '}
                  {clinic.enabledLocales
                    .map((value) => (value === 'ar' ? 'العربية' : 'Français'))
                    .join(' · ')}
                </p>
                <h4>{t.doctors}</h4>
                {clinic.doctors.length === 0 ? (
                  <p>{t.noDoctors}</p>
                ) : (
                  <ul>
                    {clinic.doctors.map((doctor, doctorIndex) => (
                      <li key={doctorIndex}>{doctor.displayName}</li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
      <footer className="publicFootnote">{t.note}</footer>
    </main>
  );
}
