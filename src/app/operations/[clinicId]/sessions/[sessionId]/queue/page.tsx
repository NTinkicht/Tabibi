import { WalkInQueue } from './walk-in-queue';

export default async function WalkInQueuePage({
  params,
}: {
  params: Promise<{ clinicId: string; sessionId: string }>;
}) {
  const { clinicId, sessionId } = await params;
  return <WalkInQueue clinicId={clinicId} sessionId={sessionId} />;
}
