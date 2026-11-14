import { StaffSettingsClient } from './staff-settings-client';

export default async function StaffSettingsPage({
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
    <StaffSettingsClient
      clinicId={clinicId}
      initialLocale={value === 'fr' ? 'fr' : 'ar'}
    />
  );
}
