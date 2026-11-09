import { redirect } from 'next/navigation';

export default async function SettingsIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { clinicId } = await params;
  const { locale } = await searchParams;
  const value = Array.isArray(locale) ? locale[0] : locale;
  redirect(
    `/operations/${encodeURIComponent(clinicId)}/settings/clinic${
      value === 'fr' ? '?locale=fr' : ''
    }`,
  );
}
