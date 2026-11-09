'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import { Button } from '@/app/ui';
import { WILAYAS } from '@/modules/clinic/wilayas';
import { clinicSetupCopy } from '@/modules/localization/clinic-setup';
import '../settings.css';
import { ClosuresSection, ConsultationTypesSection } from './clinic-sections';
import {
  timezoneOptions,
  buildProfilePatch,
  formFromProfile,
  type ClinicLocale,
  type ClinicProfile,
  type ProfileForm,
} from '../clinic-profile-model';

type Load =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'error' }
  | { kind: 'ready' };

function toProfile(raw: unknown): ClinicProfile | null {
  const c = (raw as { clinic?: Record<string, unknown> } | null)?.clinic;
  if (!c || typeof c.name !== 'string' || typeof c.timezone !== 'string')
    return null;
  const locales = Array.isArray(c.enabledLocales)
    ? c.enabledLocales.filter(
        (l): l is ClinicLocale => l === 'ar' || l === 'fr',
      )
    : [];
  if (locales.length === 0) return null;
  return {
    name: c.name,
    timezone: c.timezone,
    defaultLocale: c.defaultLocale === 'fr' ? 'fr' : 'ar',
    enabledLocales: locales,
    wilayaCode: typeof c.wilayaCode === 'string' ? c.wilayaCode : null,
    commune: typeof c.commune === 'string' ? c.commune : null,
    addressLine: typeof c.addressLine === 'string' ? c.addressLine : null,
  };
}

export function ClinicSettingsClient({
  clinicId,
  initialLocale,
}: {
  clinicId: string;
  initialLocale: ClinicLocale;
}) {
  const locale = initialLocale;
  const t = clinicSetupCopy[locale];
  const base = `/api/clinics/${encodeURIComponent(clinicId)}`;
  const other = locale === 'ar' ? 'fr' : 'ar';
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [profile, setProfile] = useState<ClinicProfile | null>(null);
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const init = {
          credentials: 'same-origin' as const,
          cache: 'no-store' as const,
          signal: controller.signal,
        };
        // GET /memberships is clinic_admin-only on the server, while the
        // clinic read is open to every clinic role: use it as the role check
        // so a non-admin never sees the editable form.
        const [res, adminProbe] = await Promise.all([
          fetch(base, init),
          fetch(`${base}/memberships`, init),
        ]);
        if (res.status === 403 || adminProbe.status === 403)
          return setLoad({ kind: 'forbidden' });
        if (!adminProbe.ok) return setLoad({ kind: 'error' });
        const parsed = res.ok ? toProfile(await res.json()) : null;
        if (!parsed) return setLoad({ kind: 'error' });
        setProfile(parsed);
        setForm(formFromProfile(parsed));
        setLoad({ kind: 'ready' });
      } catch {
        if (!controller.signal.aborted) setLoad({ kind: 'error' });
      }
    })();
    return () => controller.abort();
  }, [base]);

  const onForbidden = useCallback(() => setLoad({ kind: 'forbidden' }), []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!profile || !form) return;
    setSaved(false);
    const patch = buildProfilePatch(profile, form);
    if (!patch.ok) return setError(t.errors[patch.error]);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(base, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch.body),
      });
      if (res.status === 403) return setLoad({ kind: 'forbidden' });
      // Honest state: only a committed response updates what is shown.
      const parsed = res.ok ? toProfile(await res.json()) : null;
      if (!parsed) {
        setError(res.status === 400 ? t.errors.rejected : t.errors.failed);
        return;
      }
      setProfile(parsed);
      setForm(formFromProfile(parsed));
      setSaved(true);
    } catch {
      setError(t.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<ProfileForm>) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };
  const toggleLocale = (l: ClinicLocale) => {
    if (!form) return;
    const enabledLocales = form.enabledLocales.includes(l)
      ? form.enabledLocales.filter((x) => x !== l)
      : [...form.enabledLocales, l];
    // Keep the default language one of the offered ones.
    const defaultLocale = enabledLocales.includes(form.defaultLocale)
      ? form.defaultLocale
      : (enabledLocales[0] ?? form.defaultLocale);
    set({ enabledLocales, defaultLocale });
  };
  const timezones = profile ? timezoneOptions(profile.timezone) : [];

  return (
    <main className="cs">
      <DocumentLocaleSync locale={locale} />
      <h1>{t.pageTitle}</h1>
      <nav className="cs-tabs" aria-label={t.tabsLabel}>
        <Link
          href={`/operations/${encodeURIComponent(clinicId)}/settings/clinic?locale=${locale}`}
          aria-current="page"
        >
          {t.tabClinic}
        </Link>
        <Link
          href={`/operations/${encodeURIComponent(clinicId)}?locale=${locale}`}
        >
          {t.backToDesk}
        </Link>
        <Link
          href={`/operations/${encodeURIComponent(clinicId)}/settings/clinic?locale=${other}`}
          lang={other}
        >
          {other === 'fr' ? 'Français' : 'العربية'}
        </Link>
      </nav>
      {load.kind === 'loading' && <p role="status">{t.loading}</p>}
      {load.kind === 'forbidden' && <p role="alert">{t.adminOnly}</p>}
      {load.kind === 'error' && <p role="alert">{t.loadError}</p>}
      {load.kind === 'ready' && form && (
        <section className="cs-card">
          <h2>{t.profileTitle}</h2>
          <p className="cs-help">{t.profileHelp}</p>
          {error && (
            <div className="cs-error" role="alert" tabIndex={-1} ref={errorRef}>
              <strong>{t.errorSummary}</strong> {error}
            </div>
          )}
          <form onSubmit={onSubmit} noValidate>
            {/* Disabled while saving so no edit is lost when the response replaces the form. */}
            <fieldset className="cs-lock" disabled={busy}>
              <div className="cs-field">
                <label htmlFor="cs-name">{t.name}</label>
                <input
                  id="cs-name"
                  type="text"
                  value={form.name}
                  maxLength={200}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </div>
              <div className="cs-field">
                <label htmlFor="cs-tz">{t.timezone}</label>
                <select
                  id="cs-tz"
                  value={form.timezone}
                  onChange={(e) => set({ timezone: e.target.value })}
                >
                  {timezones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </div>
              <div className="cs-field">
                <label htmlFor="cs-wilaya">{t.wilaya}</label>
                <select
                  id="cs-wilaya"
                  value={form.wilayaCode}
                  onChange={(e) => set({ wilayaCode: e.target.value })}
                >
                  <option value="">{t.wilayaNone}</option>
                  {WILAYAS.map((w) => (
                    <option key={w.code} value={w.code}>
                      {w.code} — {w.labels[locale]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="cs-field">
                <label htmlFor="cs-commune">{t.commune}</label>
                <input
                  id="cs-commune"
                  type="text"
                  value={form.commune}
                  maxLength={100}
                  disabled={form.wilayaCode === ''}
                  onChange={(e) => set({ commune: e.target.value })}
                />
              </div>
              <div className="cs-field">
                <label htmlFor="cs-address">{t.address}</label>
                <input
                  id="cs-address"
                  type="text"
                  value={form.addressLine}
                  maxLength={200}
                  disabled={form.wilayaCode === ''}
                  onChange={(e) => set({ addressLine: e.target.value })}
                />
              </div>
              <fieldset className="cs-checks">
                <legend>{t.languages}</legend>
                {(['ar', 'fr'] as const).map((l) => (
                  <label key={l}>
                    <input
                      type="checkbox"
                      checked={form.enabledLocales.includes(l)}
                      onChange={() => toggleLocale(l)}
                    />
                    {l === 'ar' ? t.langAr : t.langFr}
                  </label>
                ))}
              </fieldset>
              <div className="cs-field">
                <label htmlFor="cs-default">{t.defaultLanguage}</label>
                <select
                  id="cs-default"
                  value={form.defaultLocale}
                  onChange={(e) =>
                    set({ defaultLocale: e.target.value as ClinicLocale })
                  }
                >
                  {form.enabledLocales.map((l) => (
                    <option key={l} value={l}>
                      {l === 'ar' ? t.langAr : t.langFr}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" disabled={busy}>
                {busy ? t.saving : t.save}
              </Button>
            </fieldset>
            {saved && (
              <p className="cs-ok" role="status">
                {t.saved}
              </p>
            )}
          </form>
        </section>
      )}
      {load.kind === 'ready' && (
        <>
          <ClosuresSection
            base={base}
            locale={locale}
            onForbidden={onForbidden}
          />
          <ConsultationTypesSection
            base={base}
            locale={locale}
            onForbidden={onForbidden}
          />
        </>
      )}
    </main>
  );
}
