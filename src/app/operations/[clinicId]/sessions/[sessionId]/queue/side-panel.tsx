'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { receptionistCopy } from '@/modules/localization/receptionist';
import type { TodayTiles } from '@/modules/receptionist-dashboard/console-view';

type Copy = (typeof receptionistCopy)['fr'] | (typeof receptionistCopy)['ar'];
type Locale = 'ar' | 'fr';

export function WalkInPanel({
  t,
  locale,
  pending,
  onSubmit,
}: {
  t: Copy;
  locale: Locale;
  pending: boolean;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const [chosen, setChosen] = useState<Locale | null>(null);
  const patientLocale = chosen ?? locale;
  return (
    <section className="createPanel" aria-labelledby="walkInTitle">
      <h2 id="walkInTitle">{t.addWalkIn}</h2>
      <p>{t.contactOptionalHint}</p>
      <form className="walkInForm" onSubmit={onSubmit}>
        <label>
          {t.guestName}
          <input required maxLength={120} name="privateDisplayName" />
        </label>
        <label>
          {t.phoneOptional}
          <input maxLength={32} name="contactPhone" inputMode="tel" dir="ltr" />
        </label>
        <label>
          {t.emailOptional}
          <input maxLength={254} name="contactEmail" type="email" dir="ltr" />
        </label>
        <fieldset className="langSegment">
          <legend>{t.patientLanguage}</legend>
          {(['ar', 'fr'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="preferredLocale"
                value={value}
                checked={patientLocale === value}
                onChange={() => setChosen(value)}
              />
              <span>
                {value === 'ar'
                  ? t.patientLanguageArabic
                  : t.patientLanguageFrench}
              </span>
            </label>
          ))}
        </fieldset>
        <label className="presentNow">
          <input type="checkbox" name="presentNow" defaultChecked />
          <span>{t.presentNow}</span>
        </label>
        <button disabled={pending}>{pending ? t.pending : t.addToQueue}</button>
      </form>
    </section>
  );
}

export function TodayTilesPanel({ t, tiles }: { t: Copy; tiles: TodayTiles }) {
  const items: Array<[string, number]> = [
    [t.tileArrived, tiles.arrived],
    [t.tileNotArrived, tiles.notArrived],
    [t.tileCompleted, tiles.completed],
    [t.tileNoShow, tiles.noShow],
  ];
  return (
    <section className="todayTiles" aria-labelledby="todayTitle">
      <h2 id="todayTitle">{t.todayTitle}</h2>
      <ul>
        {items.map(([label, value]) => (
          <li key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UndeliveredAlert({
  t,
  clinicId,
  locale,
  count,
}: {
  t: Copy;
  clinicId: string;
  locale: Locale;
  count: number;
}) {
  if (count <= 0) return null;
  return (
    <div className="undeliveredAlert" role="status">
      <span>{t.homeUndelivered.replace('{n}', String(count))}</span>
      <Link href={`/operations/${clinicId}/notifications?locale=${locale}`}>
        {t.notifications}
      </Link>
    </div>
  );
}
