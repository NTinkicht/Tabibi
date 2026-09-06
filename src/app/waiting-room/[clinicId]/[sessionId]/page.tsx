import { WaitingRoomService } from '@/modules/waiting-room';
import { getPool } from '@/platform/database/pool';

type Props = {
  params: Promise<{ clinicId: string; sessionId: string }>;
  searchParams: Promise<{ lang?: string }>;
};

const copy = {
  fr: {
    title: "Salle d'attente",
    subtitle: 'Suivez uniquement votre identifiant public.',
    waiting: 'En attente',
    checked_in: 'Présent',
    called: 'Appelé',
    empty: 'Aucun patient à afficher.',
  },
  ar: {
    title: 'قاعة الانتظار',
    subtitle: 'تابع المعرّف العام الخاص بك فقط.',
    waiting: 'في الانتظار',
    checked_in: 'حاضر',
    called: 'تم النداء',
    empty: 'لا يوجد مرضى للعرض.',
  },
} as const;

export default async function WaitingRoomPage({ params, searchParams }: Props) {
  const { clinicId, sessionId } = await params;
  const query = await searchParams;
  const locale = query.lang === 'fr' ? 'fr' : 'ar';
  const text = copy[locale];
  const snapshot = await new WaitingRoomService(getPool()).getPublicSnapshot(
    clinicId,
    sessionId,
  );

  return (
    <main dir={locale === 'ar' ? 'rtl' : 'ltr'} className="waiting-room-public">
      <header>
        <h1>{text.title}</h1>
        <p>{text.subtitle}</p>
      </header>
      {snapshot.entries.length === 0 ? (
        <p>{text.empty}</p>
      ) : (
        <ul aria-label={text.title}>
          {snapshot.entries.map((entry) => (
            <li key={entry.publicDisplayLabel} data-state={entry.state}>
              <strong>{entry.publicDisplayLabel}</strong>
              <span>{text[entry.state]}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
