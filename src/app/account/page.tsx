import { AccountClient } from './account-client';

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  const { locale } = await searchParams;
  return <AccountClient initialLocale={locale === 'fr' ? 'fr' : 'ar'} />;
}
