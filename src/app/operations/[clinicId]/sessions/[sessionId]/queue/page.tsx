import { WalkInQueue } from './walk-in-queue';

export default async function WalkInQueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string; sessionId: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { clinicId, sessionId } = await params;
  const { locale } = await searchParams;
  const initialLocale = locale === 'fr' ? 'fr' : 'ar';
  return (
    <WalkInQueue
      clinicId={clinicId}
      sessionId={sessionId}
      initialLocale={initialLocale}
    />
  );
}
