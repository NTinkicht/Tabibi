'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { PublicWaitingRoomSnapshot } from '@/modules/waiting-room';
import {
  buildTvView,
  isStale,
  nextPollDelayMs,
  parseSnapshot,
} from '@/modules/waiting-room/tv-view-model';
import './waiting-room-tv.css';

export type TvLang = 'both' | 'ar' | 'fr';

type Props = {
  initial: PublicWaitingRoomSnapshot;
  lang: TvLang;
};

const AR = {
  title: 'قاعة الانتظار',
  called: 'تم النداء',
  goToDesk: 'توجّه إلى الاستقبال',
  noneCalled: 'لا يوجد نداء بعد',
  next: 'الأدوار التالية',
  noNext: 'لا يوجد حاضرون في الانتظار',
  paused: 'الجلسة متوقفة مؤقتًا',
  live: 'مباشر',
  offline: 'غير متصل',
  staleSince: 'العرض غير محدَّث منذ',
  askReception: 'يرجى الاستفسار في الاستقبال',
  footer: 'تُعرض أرقام المرور فقط · تابع دورك على هاتفك',
  delay: (n: number) => `تأخير معلن: ${n} دقيقة`,
  more: (n: number) => `+ ${n} مريضًا آخر حضروا`,
  notArrived: (n: number) => `${n} مواعيد لم يحضر أصحابها بعد`,
};
const FR = {
  title: "Salle d'attente",
  called: 'Appelé',
  goToDesk: "Présentez-vous à l'accueil",
  noneCalled: "Pas encore d'appel",
  next: 'Prochains',
  noNext: 'Aucun patient arrivé en attente',
  paused: 'Séance en pause',
  live: 'En direct',
  offline: 'Hors ligne',
  staleSince: 'Affichage non à jour depuis',
  askReception: "Renseignez-vous à l'accueil",
  footer:
    'Seuls les numéros de passage sont affichés · Suivez votre passage sur votre téléphone',
  delay: (n: number) => `Retard annoncé : ${n} min`,
  more: (n: number) => `+ ${n} autres patients arrivés`,
  notArrived: (n: number) => `${n} rendez-vous pas encore arrivés`,
};

type Key = {
  [K in keyof typeof AR]: (typeof AR)[K] extends string ? K : never;
}[keyof typeof AR];
type Fn = Exclude<keyof typeof AR, Key>;

function Bi({ lang, k, n }: { lang: TvLang; k: Key | Fn; n?: number }) {
  const render = (dict: typeof AR | typeof FR) => {
    const value = dict[k];
    return typeof value === 'function' ? value(n ?? 0) : value;
  };
  return (
    <>
      {lang !== 'fr' ? (
        <span lang="ar" dir="rtl" className="tv-ar">
          {render(AR)}
        </span>
      ) : null}
      {lang === 'both' ? ' ' : null}
      {lang !== 'ar' ? (
        <span lang="fr" dir="ltr" className="tv-fr">
          {render(FR)}
        </span>
      ) : null}
    </>
  );
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WaitingRoomDisplay({ initial, lang }: Props) {
  const [snapshot, setSnapshot] = useState(initial);
  const [lastSuccessMs, setLastSuccessMs] = useState<number>(() => Date.now());
  const [nowMs, setNowMs] = useState<number | null>(null);
  const failures = useRef(0);
  // Taken from the route on the client so identifiers are not serialised into props.
  const params = useParams<{ clinicId: string; sessionId: string }>();
  const apiPath = `/api/public/clinics/${params.clinicId}/sessions/${params.sessionId}/waiting-room`;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const first = setTimeout(() => setNowMs(Date.now()), 0);

    const poll = async () => {
      controller = new AbortController();
      try {
        const response = await fetch(apiPath, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const parsed = response.ok
          ? parseSnapshot(await response.json())
          : null;
        if (!parsed) throw new Error('waiting_room_poll_rejected');
        if (cancelled) return;
        failures.current = 0;
        setSnapshot(parsed);
        setLastSuccessMs(Date.now());
      } catch {
        if (cancelled) return;
        failures.current += 1;
      }
      if (!cancelled)
        timer = setTimeout(poll, nextPollDelayMs(failures.current));
    };
    timer = setTimeout(poll, nextPollDelayMs(0));
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(tick);
      clearTimeout(first);
      if (timer) clearTimeout(timer);
    };
  }, [apiPath]);

  const stale = nowMs !== null && isStale(lastSuccessMs, nowMs);
  const view = buildTvView(snapshot.entries);
  const [lead, ...others] = view.called;
  const listTitle =
    lang === 'ar'
      ? AR.title
      : lang === 'fr'
        ? FR.title
        : `${AR.title} ${FR.title}`;
  const calledTitle =
    lang === 'ar'
      ? AR.called
      : lang === 'fr'
        ? FR.called
        : `${AR.called} ${FR.called}`;
  const dir = lang === 'fr' ? 'ltr' : 'rtl';
  const { pauseStatus, declaredDelayMinutes } = snapshot.session;

  return (
    <main dir={dir} className="waiting-room-public tv" data-lang={lang}>
      <header className="tv-header">
        <h1>
          <Bi lang={lang} k="title" />
        </h1>
        <p
          className="tv-indicator"
          data-connection={stale ? 'offline' : 'live'}
          role="status"
        >
          <Bi lang={lang} k={stale ? 'offline' : 'live'} />
        </p>
        <time className="tv-clock" suppressHydrationWarning>
          {nowMs === null
            ? ''
            : new Date(nowMs).toLocaleTimeString('fr-FR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
        </time>
      </header>

      {stale ? (
        <section className="tv-stale" role="alert" data-testid="tv-stale">
          <p className="tv-stale-title">
            <Bi lang={lang} k="staleSince" /> {hhmm(snapshot.generatedAt)}
          </p>
          <p>
            <Bi lang={lang} k="askReception" />
          </p>
        </section>
      ) : (
        <>
          {pauseStatus === 'paused' || declaredDelayMinutes > 0 ? (
            <section className="tv-banner" data-testid="tv-banner">
              {pauseStatus === 'paused' ? (
                <p>
                  <Bi lang={lang} k="paused" />
                </p>
              ) : null}
              {declaredDelayMinutes > 0 ? (
                <p>
                  <Bi lang={lang} k="delay" n={declaredDelayMinutes} />
                </p>
              ) : null}
            </section>
          ) : null}
          <div className="tv-body">
            <section className="tv-called" aria-live="assertive">
              <h2>
                <Bi lang={lang} k="called" />
              </h2>
              {lead ? (
                <>
                  <ul aria-label={calledTitle}>
                    <li key={lead} className="tv-lead" data-testid="tv-lead">
                      <bdi>{lead}</bdi>
                    </li>
                    {others.map((label) => (
                      <li key={label} className="tv-other">
                        <bdi>{label}</bdi>
                      </li>
                    ))}
                  </ul>
                  <p>
                    <Bi lang={lang} k="goToDesk" />
                  </p>
                </>
              ) : (
                <p className="tv-none">
                  <Bi lang={lang} k="noneCalled" />
                </p>
              )}
            </section>
            <section className="tv-next">
              <h2>
                <Bi lang={lang} k="next" />
              </h2>
              {view.next.length > 0 ? (
                <ol aria-label={listTitle}>
                  {view.next.map((label, index) => (
                    <li key={label} data-first={index === 0}>
                      <bdi>{label}</bdi>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="tv-none">
                  <Bi lang={lang} k="noNext" />
                </p>
              )}
              {view.moreArrived > 0 ? (
                <p className="tv-count">
                  <Bi lang={lang} k="more" n={view.moreArrived} />
                </p>
              ) : null}
              {view.notYetArrived > 0 ? (
                <p className="tv-count">
                  <Bi lang={lang} k="notArrived" n={view.notYetArrived} />
                </p>
              ) : null}
            </section>
          </div>
        </>
      )}
      <footer className="tv-footer">
        <Bi lang={lang} k="footer" />
      </footer>
    </main>
  );
}
