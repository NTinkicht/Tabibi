import { ResetClient } from './reset-client';

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  const { locale } = await searchParams;
  return <ResetClient initialLocale={locale === 'fr' ? 'fr' : 'ar'} />;
}
