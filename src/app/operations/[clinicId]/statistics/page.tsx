import { StatisticsClient } from './statistics-client';

export default async function StatisticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { clinicId } = await params;
  const { locale } = await searchParams;
  return (
    <StatisticsClient
      clinicId={clinicId}
      initialLocale={locale === 'fr' ? 'fr' : 'ar'}
    />
  );
}
