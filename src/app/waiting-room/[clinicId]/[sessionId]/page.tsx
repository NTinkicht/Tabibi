import { WaitingRoomService } from '@/modules/waiting-room';
import { getPool } from '@/platform/database/pool';
import { WaitingRoomDisplay } from '../../WaitingRoomDisplay';

type Props = {
  params: Promise<{ clinicId: string; sessionId: string }>;
  searchParams: Promise<{ lang?: string }>;
};

export const dynamic = 'force-dynamic';

export default async function WaitingRoomPage({ params, searchParams }: Props) {
  const { clinicId, sessionId } = await params;
  const query = await searchParams;
  // Bilingual (Arabic + French) by default; ?lang= keeps single-language screens.
  const lang = query.lang === 'fr' ? 'fr' : query.lang === 'ar' ? 'ar' : 'both';
  const snapshot = await new WaitingRoomService(getPool()).getPublicSnapshot(
    clinicId,
    sessionId,
  );

  return <WaitingRoomDisplay initial={snapshot} lang={lang} />;
}
