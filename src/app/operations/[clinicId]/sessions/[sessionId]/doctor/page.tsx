import { DoctorView } from './doctor-view';

export default async function DoctorPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string; sessionId: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { clinicId, sessionId } = await params;
  const { locale } = await searchParams;
  return (
    <DoctorView
      clinicId={clinicId}
      sessionId={sessionId}
      initialLocale={locale === 'fr' ? 'fr' : 'ar'}
    />
  );
}
