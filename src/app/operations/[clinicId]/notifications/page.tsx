import { NotificationDeliveryExceptionsClient } from './notification-delivery-exceptions-client';

export default async function NotificationDeliveryExceptionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { clinicId } = await params;
  const { locale } = await searchParams;
  return (
    <NotificationDeliveryExceptionsClient
      clinicId={clinicId}
      initialLocale={locale === 'fr' ? 'fr' : 'ar'}
    />
  );
}
