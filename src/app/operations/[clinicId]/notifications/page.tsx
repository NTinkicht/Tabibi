import { NotificationDeliveryExceptionsClient } from './notification-delivery-exceptions-client';

export default async function NotificationDeliveryExceptionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { clinicId } = await params;
  const { locale } = await searchParams;
  const resolvedLocale = Array.isArray(locale) ? locale[0] : locale;
  return (
    <NotificationDeliveryExceptionsClient
      clinicId={clinicId}
      initialLocale={resolvedLocale === 'fr' ? 'fr' : 'ar'}
    />
  );
}
