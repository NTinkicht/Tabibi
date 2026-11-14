'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { DocumentLocaleSync } from '@/app/DocumentLocaleSync';
import { Button } from '@/app/ui';
import {
  MAX_SPECIALTIES_PER_ASSOCIATION,
  SPECIALTIES,
} from '@/modules/clinic/specialties';
import { clinicSetupCopy } from '@/modules/localization/clinic-setup';
import '../settings.css';
import {
  buildAddDoctorBody,
  buildSpecialtiesBody,
  eligibleMembers,
  parseDoctors,
  parseMembers,
  toggleSpecialty,
  type DoctorRow,
  type MemberRow,
} from '../doctor-model';
import { SettingsTabs } from '../settings-tabs';
import {
  AbsencesSection,
  GenerateSection,
  WeekSection,
} from './schedule-sections';

type Locale = 'ar' | 'fr';
type Load = 'loading' | 'forbidden' | 'error' | 'ready';
const JSON_HEADERS = { 'content-type': 'application/json' };

export function DoctorsSettingsClient({
  clinicId,
  initialLocale,
}: {
  clinicId: string;
  initialLocale: Locale;
}) {
  const locale = initialLocale;
  const t = clinicSetupCopy[locale];
  const base = `/api/clinics/${encodeURIComponent(clinicId)}`;
  const [load, setLoad] = useState<Load>('loading');
  const [doctors, setDoctors] = useState<DoctorRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [tick, setTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const onForbidden = useCallback(() => setLoad('forbidden'), []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const init = {
          credentials: 'same-origin' as const,
          cache: 'no-store' as const,
          signal: controller.signal,
        };
        // GET /memberships is clinic_admin-only: it doubles as the role check.
        const [d, m] = await Promise.all([
          fetch(`${base}/doctors`, init),
          fetch(`${base}/memberships`, init),
        ]);
        if (d.status === 403 || m.status === 403) return setLoad('forbidden');
        const docs = d.ok ? parseDoctors(await d.json()) : null;
        const mems = m.ok ? parseMembers(await m.json()) : null;
        if (!docs || !mems) return setLoad('error');
        setDoctors(docs);
        setMembers(mems);
        setLoad('ready');
      } catch {
        if (!controller.signal.aborted) setLoad('error');
      }
    })();
    return () => controller.abort();
  }, [base, tick]);

  const selected = doctors.find((d) => d.id === selectedId) ?? null;
  const choices = eligibleMembers(members, doctors);

  function select(doctor: DoctorRow) {
    setSelectedId(doctor.id);
    setDraft(doctor.specialtyCodes);
    setError(null);
    setOk(null);
  }

  async function send(
    url: string,
    method: 'POST' | 'PATCH',
    body: unknown,
    success: string,
  ): Promise<boolean> {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (res.status === 403) {
        setLoad('forbidden');
        return false;
      }
      if (!res.ok) {
        setError(t.actionFailed);
        return false;
      }
      // Honest state: re-read the committed list instead of patching locally.
      reload();
      setOk(success);
      return true;
    } catch {
      setError(t.actionFailed);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    const built = buildAddDoctorBody({ userId, displayName: name });
    if (!built.ok) return setError(t.doctorErrors[built.error]);
    if (await send(`${base}/doctors`, 'POST', built.body, t.doctorAdded)) {
      setUserId('');
      setName('');
    }
  }

  async function onSaveSpecialties(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const built = buildSpecialtiesBody(draft);
    if (!built.ok) return setError(t.specialtiesNeedOne);
    await send(
      `${base}/doctors/${encodeURIComponent(selected.id)}`,
      'PATCH',
      built.body,
      t.specialtiesSaved,
    );
  }

  const label = (code: string) =>
    SPECIALTIES.find((s) => s.code === code)?.labels[locale] ?? code;

  return (
    <main className="cs">
      <DocumentLocaleSync locale={locale} />
      <h1>{t.pageTitle}</h1>
      <SettingsTabs clinicId={clinicId} locale={locale} active="doctors" />
      {load === 'loading' && <p role="status">{t.loading}</p>}
      {load === 'forbidden' && <p role="alert">{t.adminOnly}</p>}
      {load === 'error' && <p role="alert">{t.loadError}</p>}
      {load === 'ready' && (
        <>
          {error && (
            <div className="cs-error" role="alert" tabIndex={-1} ref={errorRef}>
              {error}
            </div>
          )}
          {ok && (
            <p className="cs-ok" role="status">
              {ok}
            </p>
          )}
          <section className="cs-card" aria-labelledby="cs-doctors-title">
            <h2 id="cs-doctors-title">{t.doctorsTitle}</h2>
            <p className="cs-help">{t.doctorsHelp}</p>
            {doctors.length === 0 && <p>{t.doctorsEmpty}</p>}
            <ul className="cs-list">
              {doctors.map((d) => (
                <li key={d.id} className="cs-row">
                  <span>
                    <bdi>{d.displayName}</bdi>
                    {' — '}
                    {d.specialtyCodes.length === 0
                      ? t.doctorNoSpecialty
                      : d.specialtyCodes.map(label).join(', ')}
                  </span>
                  <Button
                    variant="secondary"
                    aria-pressed={d.id === selectedId}
                    onClick={() => select(d)}
                  >
                    {t.doctorManage}
                    <span className="cs-sr">
                      {' '}
                      <bdi>{d.displayName}</bdi>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
          <section className="cs-card" aria-labelledby="cs-add-doctor-title">
            <h2 id="cs-add-doctor-title">{t.addDoctorTitle}</h2>
            <p className="cs-help">{t.addDoctorHelp}</p>
            {choices.length === 0 ? (
              <p>{t.noEligibleMember}</p>
            ) : (
              <form onSubmit={onAdd} noValidate>
                <fieldset className="cs-lock" disabled={busy}>
                  <div className="cs-field">
                    <label htmlFor="cs-member">{t.memberLabel}</label>
                    <select
                      id="cs-member"
                      value={userId}
                      onChange={(e) => setUserId(e.target.value)}
                    >
                      <option value="">{t.memberChoose}</option>
                      {choices.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.displayName} ({m.identifier})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="cs-field">
                    <label htmlFor="cs-doctor-name">{t.publicName}</label>
                    <input
                      id="cs-doctor-name"
                      type="text"
                      value={name}
                      maxLength={120}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                  <Button type="submit">{t.addDoctor}</Button>
                </fieldset>
              </form>
            )}
          </section>
          {selected && (
            <section className="cs-card" aria-labelledby="cs-spec-title">
              <h2 id="cs-spec-title">
                {t.specialtiesTitle} — <bdi>{selected.displayName}</bdi>
              </h2>
              <form onSubmit={onSaveSpecialties} noValidate>
                <fieldset className="cs-lock" disabled={busy}>
                  <fieldset className="cs-specs">
                    <legend className="cs-sr">
                      {t.specialtiesFor} {selected.displayName}
                    </legend>
                    {SPECIALTIES.map((s) => {
                      const checked = draft.includes(s.code);
                      return (
                        <label key={s.code}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={
                              !checked &&
                              draft.length >= MAX_SPECIALTIES_PER_ASSOCIATION
                            }
                            onChange={() =>
                              setDraft((c) => toggleSpecialty(c, s.code))
                            }
                          />
                          {s.labels[locale]}
                        </label>
                      );
                    })}
                  </fieldset>
                  <Button type="submit">{t.specialtiesSave}</Button>
                </fieldset>
              </form>
            </section>
          )}
          {selected && (
            <>
              <WeekSection
                key={`week-${selected.id}`}
                base={base}
                doctorId={selected.id}
                locale={locale}
                onForbidden={onForbidden}
              />
              <GenerateSection
                key={`gen-${selected.id}`}
                base={base}
                doctorId={selected.id}
                locale={locale}
                onForbidden={onForbidden}
              />
              <AbsencesSection
                key={`abs-${selected.id}`}
                base={base}
                doctorId={selected.id}
                locale={locale}
                onForbidden={onForbidden}
              />
            </>
          )}
        </>
      )}
    </main>
  );
}
