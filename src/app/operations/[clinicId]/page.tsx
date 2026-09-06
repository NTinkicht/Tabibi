import { ReceptionDesk } from './reception-desk';

export default async function OperationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { clinicId } = await params;
  const { locale } = await searchParams;
  const initialLocale = locale === 'fr' ? 'fr' : 'ar';
  return <ReceptionDesk clinicId={clinicId} initialLocale={initialLocale} />;
}
