import { InviteForm } from './invite-form';

// G-18 (#824): the one-time invite link is /staff/invite#<token>. The token is
// in the URL fragment, which browsers never send to the server, so it stays
// out of access logs, referrers and analytics.
export default async function StaffInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  const { locale } = await searchParams;
  return <InviteForm initialLocale={locale === 'fr' ? 'fr' : 'ar'} />;
}
