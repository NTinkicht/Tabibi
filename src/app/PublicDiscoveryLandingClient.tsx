'use client';

import { useEffect, useRef, useState } from 'react';

type Locale = 'ar' | 'fr';
type ClinicLanguageFilter = Locale | 'all';
type ClinicSort = 'original' | 'ascending' | 'descending';
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
    clinicLanguageLabel: 'Langue proposée par la clinique',
    clinicLanguageAll: 'Toutes les langues',
    clinicLanguageFrench: 'Français',
    clinicLanguageArabic: 'العربية',
    onlyListedDoctors: 'Cliniques avec médecins affichés uniquement',
    clinicSortLabel: 'Trier les cliniques par nom',
    clinicSortOriginal: 'Ordre initial',
    clinicSortAscending: 'Nom : A à Z',
    clinicSortDescending: 'Nom : Z à A',
    noFilteredMatches:
      'Aucune clinique ne correspond aux filtres sélectionnés.',
    searchPlaceholder: 'Nom de la clinique ou du médecin',
    clearSearch: 'Effacer la recherche',
    clearAllFilters: 'Effacer tous les filtres',
    searchCount: (count: number) =>
      `${count} clinique${count === 1 ? '' : 's'} trouvée${count === 1 ? '' : 's'}.`,
    searchDoctorTotal: (count: number) =>
      `${count} médecin${count === 1 ? '' : 's'} affiché${count === 1 ? '' : 's'} au total dans les résultats.`,
    noSearchMatches:
      'Aucune clinique ni aucun médecin ne correspond à votre recherche.',
    refresh: 'Actualiser',
    refreshed: (count: number) =>
      `Répertoire actualisé : ${count} clinique${count === 1 ? '' : 's'}.`,
    doctors: 'Médecins',
    listedDoctorCount: (count: number) =>
      `${count} médecin${count === 1 ? '' : 's'} affiché${count === 1 ? '' : 's'}`,
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
    clinicLanguageLabel: 'اللغة المتاحة في العيادة',
    clinicLanguageAll: 'كل اللغات',
    clinicLanguageFrench: 'الفرنسية',
    clinicLanguageArabic: 'العربية',
    onlyListedDoctors: 'العيادات التي تعرض أطباء فقط',
    clinicSortLabel: 'ترتيب العيادات حسب الاسم',
    clinicSortOriginal: 'الترتيب الأصلي',
    clinicSortAscending: 'الاسم: تصاعديًا',
    clinicSortDescending: 'الاسم: تنازليًا',
    noFilteredMatches: 'لا توجد عيادات تطابق عوامل التصفية المحددة.',
    searchPlaceholder: 'اسم العيادة أو الطبيب',
    clearSearch: 'مسح البحث',
    clearAllFilters: 'مسح جميع عوامل التصفية',
    searchCount: (count: number) => `نتائج البحث: ${count} عيادة.`,
    searchDoctorTotal: (count: number) =>
      `إجمالي الأطباء المعروضين في النتائج: ${count}.`,
    noSearchMatches: 'لا توجد عيادات أو أطباء يطابقون بحثك.',
    refresh: 'تحديث',
    refreshed: (count: number) => `تم تحديث الدليل: ${count} عيادة.`,
    doctors: 'الأطباء',
    listedDoctorCount: (count: number) =>
      count === 1
        ? 'طبيب واحد في القائمة'
        : count === 2
          ? 'طبيبان في القائمة'
          : `${count} أطباء في القائمة`,
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

function doctorsVisibleForQuery(
  clinic: PublicClinic,
  query: string,
): PublicClinic['doctors'] {
  if (!query || normalizeSearch(clinic.name).includes(query)) {
    return clinic.doctors;
  }
  return clinic.doctors.filter((doctor) =>
    normalizeSearch(doctor.displayName).includes(query),
  );
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

/**
 * Render the public clinic directory and announce counts of the public doctor
 * names actually visible after language, doctor and name filtering.
 */
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
  const [clinicLanguage, setClinicLanguage] =
    useState<ClinicLanguageFilter>('all');
  const [clinicSort, setClinicSort] = useState<ClinicSort>('original');
  const [onlyListedDoctors, setOnlyListedDoctors] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [refreshCount, setRefreshCount] = useState<number | null>(null);
  const t = copy[locale];
  const query = normalizeSearch(search.trim());
  const noMatchesCopy =
    clinicLanguage !== 'all' || onlyListedDoctors
      ? t.noFilteredMatches
      : t.noSearchMatches;
  const matchingClinics = clinics.filter(
    (clinic) =>
      (clinicLanguage === 'all' ||
        clinic.enabledLocales.includes(clinicLanguage)) &&
      (!onlyListedDoctors || clinic.doctors.length > 0) &&
      (!query ||
        normalizeSearch(clinic.name).includes(query) ||
        clinic.doctors.some((doctor) =>
          normalizeSearch(doctor.displayName).includes(query),
        )),
  );
  // Count exactly the doctors rendered inside the matching clinic cards:
  // a clinic-name match exposes its full public list; a doctor-name-only
  // match exposes only matching public names (WU103).
  const visibleDoctorTotal = matchingClinics.reduce(
    (total, clinic) => total + doctorsVisibleForQuery(clinic, query).length,
    0,
  );
  const collator = new Intl.Collator(locale, {
    sensitivity: 'base',
    numeric: true,
  });
  const sortedClinics =
    clinicSort === 'original'
      ? matchingClinics
      : matchingClinics
          .map((clinic, originalIndex) => ({ clinic, originalIndex }))
          .sort((left, right) => {
            const compared = collator.compare(
              left.clinic.name,
              right.clinic.name,
            );
            return (
              (clinicSort === 'ascending' ? compared : -compared) ||
              left.originalIndex - right.originalIndex
            );
          })
          .map(({ clinic }) => clinic);

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
                ref={searchInputRef}
                type="search"
                autoComplete="off"
                maxLength={120}
                placeholder={t.searchPlaceholder}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    searchInputRef.current?.focus();
                  }}
                >
                  {t.clearSearch}
                </button>
              )}
            </div>
            <label htmlFor="publicClinicLanguage">
              {t.clinicLanguageLabel}
            </label>
            <select
              id="publicClinicLanguage"
              value={clinicLanguage}
              onChange={(event) =>
                setClinicLanguage(event.target.value as ClinicLanguageFilter)
              }
            >
              <option value="all">{t.clinicLanguageAll}</option>
              <option value="fr">{t.clinicLanguageFrench}</option>
              <option value="ar">{t.clinicLanguageArabic}</option>
            </select>
            <label
              className="publicDoctorFilter"
              htmlFor="publicClinicsWithDoctors"
            >
              <input
                id="publicClinicsWithDoctors"
                type="checkbox"
                checked={onlyListedDoctors}
                onChange={(event) => setOnlyListedDoctors(event.target.checked)}
              />
              <span>{t.onlyListedDoctors}</span>
            </label>
            <label htmlFor="publicClinicSort">{t.clinicSortLabel}</label>
            <select
              id="publicClinicSort"
              value={clinicSort}
              onChange={(event) =>
                setClinicSort(event.target.value as ClinicSort)
              }
            >
              <option value="original">{t.clinicSortOriginal}</option>
              <option value="ascending">{t.clinicSortAscending}</option>
              <option value="descending">{t.clinicSortDescending}</option>
            </select>
            {(search.length > 0 ||
              clinicLanguage !== 'all' ||
              onlyListedDoctors) && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setClinicLanguage('all');
                  setOnlyListedDoctors(false);
                  searchInputRef.current?.focus();
                }}
              >
                {t.clearAllFilters}
              </button>
            )}
            {(query || clinicLanguage !== 'all' || onlyListedDoctors) && (
              <div role="status" aria-live="polite" aria-atomic="true">
                <p>{t.searchCount(matchingClinics.length)}</p>
                <p>{t.searchDoctorTotal(visibleDoctorTotal)}</p>
              </div>
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
          (query || clinicLanguage !== 'all' || onlyListedDoctors) &&
          matchingClinics.length === 0 && (
            <p className="publicNotice" role="status">
              {noMatchesCopy}
            </p>
          )}
        {state === 'ready' && matchingClinics.length > 0 && (
          <div className="publicGrid">
            {sortedClinics.map((clinic, index) => {
              const visibleDoctors = doctorsVisibleForQuery(clinic, query);
              return (
                <article className="publicClinic" key={index}>
                  <h3>{clinic.name}</h3>
                  <p className="publicLanguages">
                    {t.languages}:{' '}
                    {clinic.enabledLocales
                      .map((value) => (value === 'ar' ? 'العربية' : 'Français'))
                      .join(' · ')}
                  </p>
                  <h4>{t.doctors}</h4>
                  {visibleDoctors.length > 0 && (
                    <p className="publicDoctorCount">
                      {t.listedDoctorCount(visibleDoctors.length)}
                    </p>
                  )}
                  {visibleDoctors.length === 0 ? (
                    <p>{t.noDoctors}</p>
                  ) : (
                    <ul>
                      {visibleDoctors.map((doctor, doctorIndex) => (
                        <li key={doctorIndex}>{doctor.displayName}</li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
      <footer className="publicFootnote">{t.note}</footer>
    </main>
  );
}
