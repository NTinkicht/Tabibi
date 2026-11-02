import { SignInForm } from './sign-in-form';
import { safeReturnPath } from './return-path';

export default async function StaffSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string; returnTo?: string }>;
}) {
  const { locale, returnTo } = await searchParams;
  return (
    <SignInForm
      initialLocale={locale === 'fr' ? 'fr' : 'ar'}
      returnTo={safeReturnPath(returnTo)}
    />
  );
}
