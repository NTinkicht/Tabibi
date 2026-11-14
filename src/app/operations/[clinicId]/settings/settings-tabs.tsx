import Link from 'next/link';
import { clinicSetupCopy } from '@/modules/localization/clinic-setup';

type Locale = 'ar' | 'fr';

// Shared tab links of the clinic settings screens: one URL per tab, so reload
// and back keep the tab (docs/design/clinic-setup.md, Shell).
export function SettingsTabs({
  clinicId,
  locale,
  active,
}: {
  clinicId: string;
  locale: Locale;
  active: 'clinic' | 'doctors';
}) {
  const t = clinicSetupCopy[locale];
  const other: Locale = locale === 'ar' ? 'fr' : 'ar';
  const root = `/operations/${encodeURIComponent(clinicId)}`;
  const current = (tab: string) =>
    tab === active ? ({ 'aria-current': 'page' } as const) : {};
  return (
    <nav className="cs-tabs" aria-label={t.tabsLabel}>
      <Link
        href={`${root}/settings/clinic?locale=${locale}`}
        {...current('clinic')}
      >
        {t.tabClinic}
      </Link>
      <Link
        href={`${root}/settings/doctors?locale=${locale}`}
        {...current('doctors')}
      >
        {t.tabDoctors}
      </Link>
      <Link href={`${root}?locale=${locale}`}>{t.backToDesk}</Link>
      <Link href={`${root}/settings/${active}?locale=${other}`} lang={other}>
        {other === 'fr' ? 'Français' : 'العربية'}
      </Link>
    </nav>
  );
}
