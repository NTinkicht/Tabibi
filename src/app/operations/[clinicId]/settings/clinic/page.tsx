import { ClinicSettingsClient } from './clinic-settings-client';

export default async function ClinicSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { clinicId } = await params;
  const { locale } = await searchParams;
  const value = Array.isArray(locale) ? locale[0] : locale;
  return (
    <ClinicSettingsClient
      clinicId={clinicId}
      initialLocale={value === 'fr' ? 'fr' : 'ar'}
    />
  );
}
