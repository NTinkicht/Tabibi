import { ReceptionDesk } from './reception-desk';
export default async function OperationsPage({
  params,
}: {
  params: Promise<{ clinicId: string }>;
}) {
  const { clinicId } = await params;
  return <ReceptionDesk clinicId={clinicId} />;
}
