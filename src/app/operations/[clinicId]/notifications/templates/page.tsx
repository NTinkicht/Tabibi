import { TemplatesClient } from './templates-client';

export default async function NotificationTemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { clinicId } = await params;
  const { locale } = await searchParams;
  return (
    <TemplatesClient
      clinicId={clinicId}
      initialLocale={locale === 'fr' ? 'fr' : 'ar'}
    />
  );
}
