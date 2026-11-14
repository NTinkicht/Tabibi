import Link from 'next/link';
import type { TodayTiles } from '@/modules/receptionist-dashboard/console-view';

// docs/design/reception-console.md "Tablet" header: session switcher (doctor +
// hours, leads back to the sessions home) and today's counts as one line.
// Hidden by CSS outside the tablet query; counts come from the same
// server-derived entries as the desktop "today" tiles.
export function countsLine(
  labels: {
    arrived: string;
    notArrived: string;
    completed: string;
    noShow: string;
  },
  tiles: TodayTiles,
): string {
  return [
    `${labels.arrived} ${tiles.arrived}`,
    `${labels.notArrived} ${tiles.notArrived}`,
    `${labels.completed} ${tiles.completed}`,
    `${labels.noShow} ${tiles.noShow}`,
  ].join(' · ');
}

export function TabletHeaderBar({
  href,
  switchLabel,
  doctor,
  hours,
  counts,
}: {
  href: string;
  switchLabel: string;
  doctor: string;
  hours: string;
  counts: string;
}) {
  return (
    <div className="tabletHeaderBar">
      <Link
        className="sessionSwitcher"
        href={href}
        aria-label={`${switchLabel} : ${doctor} ${hours}`}
      >
        <strong>{doctor}</strong>
        <span dir="ltr">{hours}</span>
      </Link>
      <p className="countsLine" aria-label={counts}>
        {counts}
      </p>
    </div>
  );
}
