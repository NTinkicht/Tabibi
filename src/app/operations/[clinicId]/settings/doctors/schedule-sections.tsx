'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Button } from '@/app/ui';
import { clinicSetupCopy } from '@/modules/localization/clinic-setup';
import {
  GENERATION_WEEKS,
  WEEKDAY_ORDER,
  activeRanges,
  buildGenerationBody,
  buildTemplateBody,
  fillTemplate,
  formatLongDay,
  parseAbsences,
  parseGenerated,
  parseTemplates,
  periodEnd,
  weekdayName,
  type TemplateRow,
} from '../schedule-model';

type Locale = 'ar' | 'fr';
type Props = {
  base: string;
  doctorId: string;
  locale: Locale;
  onForbidden: () => void;
};

const JSON_HEADERS = { 'content-type': 'application/json' };

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Shared by the three panels: one error box (focused), one status line, and a
// mutate helper that re-reads committed state instead of patching locally.
function usePanel(onForbidden: () => void, reload: () => void) {
  const t = (loc: Locale) => clinicSetupCopy[loc];
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function mutate(
    locale: Locale,
    request: () => Promise<Response>,
    success: string,
    conflict?: string,
  ): Promise<Response | null> {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const res = await request();
      if (res.status === 403) {
        onForbidden();
        return null;
      }
      if (!res.ok) {
        setError(
          res.status === 409 && conflict ? conflict : t(locale).actionFailed,
        );
        return null;
      }
      reload();
      setOk(success);
      return res;
    } catch {
      setError(t(locale).actionFailed);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { error, setError, ok, setOk, busy, errorRef, mutate };
}

function Messages({
  error,
  ok,
  errorRef,
}: {
  error: string | null;
  ok: string | null;
  errorRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      {error && (
        <div className="cs-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </div>
      )}
      {ok && (
        <p className="cs-ok" role="status">
          {ok}
        </p>
      )}
    </>
  );
}

export function WeekSection({ base, doctorId, locale, onForbidden }: Props) {
  const t = clinicSetupCopy[locale];
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const panel = usePanel(onForbidden, reload);
  const [adding, setAdding] = useState<number | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `${base}/schedule-templates?doctorId=${encodeURIComponent(doctorId)}`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (res.status === 403) return onForbidden();
        const parsed = res.ok ? parseTemplates(await res.json()) : null;
        if (parsed) setTemplates(parsed);
        else panel.setError(t.sectionLoadError);
      } catch {
        if (!controller.signal.aborted) panel.setError(t.sectionLoadError);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, doctorId, tick, onForbidden]);

  function onAdd(event: FormEvent, weekday: number) {
    event.preventDefault();
    const built = buildTemplateBody({
      doctorId,
      weekday,
      start,
      end,
      templates: templates ?? [],
    });
    if (!built.ok) return panel.setError(t.weekErrors[built.error]);
    void panel
      .mutate(
        locale,
        () =>
          fetch(`${base}/schedule-templates`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: JSON_HEADERS,
            body: JSON.stringify(built.body),
          }),
        t.weekRangeAdded,
        t.weekOverlap,
      )
      .then((res) => {
        if (res) {
          setAdding(null);
          setStart('');
          setEnd('');
        }
      });
  }

  return (
    <section className="cs-card" aria-labelledby="cs-week-title">
      <h2 id="cs-week-title">{t.weekTitle}</h2>
      <p className="cs-help">{t.weekHelp}</p>
      <Messages {...panel} />
      {templates && (
        <ul className="cs-list">
          {WEEKDAY_ORDER.map((weekday) => {
            const ranges = activeRanges(templates, weekday);
            return (
              <li key={weekday} className="cs-day">
                <strong>{weekdayName(weekday, locale)}</strong>
                {ranges.length === 0 && <span>{t.weekNone}</span>}
                {ranges.map((r) => (
                  <span key={r.id} className="cs-range">
                    <bdi dir="ltr">
                      {r.localStartTime}–{r.localEndTime}
                    </bdi>
                    <Button
                      variant="secondary"
                      disabled={panel.busy}
                      aria-label={`${t.weekRemoveRange} ${weekdayName(weekday, locale)} ${r.localStartTime}–${r.localEndTime}`}
                      onClick={() =>
                        void panel.mutate(
                          locale,
                          () =>
                            fetch(
                              `${base}/schedule-templates/${encodeURIComponent(r.id)}`,
                              {
                                method: 'PATCH',
                                credentials: 'same-origin',
                                headers: JSON_HEADERS,
                                body: JSON.stringify({ active: false }),
                              },
                            ),
                          t.weekRangeRemoved,
                        )
                      }
                    >
                      ×
                    </Button>
                  </span>
                ))}
                {adding === weekday ? (
                  <form
                    className="cs-inline"
                    onSubmit={(e) => onAdd(e, weekday)}
                    noValidate
                  >
                    <div className="cs-field">
                      <label htmlFor={`cs-start-${weekday}`}>
                        {t.weekStart}
                      </label>
                      <input
                        id={`cs-start-${weekday}`}
                        type="time"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </div>
                    <div className="cs-field">
                      <label htmlFor={`cs-end-${weekday}`}>{t.weekEnd}</label>
                      <input
                        id={`cs-end-${weekday}`}
                        type="time"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                      />
                    </div>
                    <Button type="submit" disabled={panel.busy}>
                      {t.weekSaveRange}
                    </Button>
                  </form>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={panel.busy}
                    onClick={() => {
                      setAdding(weekday);
                      setStart('');
                      setEnd('');
                      panel.setError(null);
                    }}
                  >
                    {t.weekAddRange}
                    <span className="cs-sr">
                      {' '}
                      — {weekdayName(weekday, locale)}
                    </span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function GenerateSection({
  base,
  doctorId,
  locale,
  onForbidden,
}: Props) {
  const t = clinicSetupCopy[locale];
  const panel = usePanel(onForbidden, () => undefined);
  const [startDate, setStartDate] = useState(today);
  const [weeks, setWeeks] = useState<number>(4);

  async function onRun(event: FormEvent) {
    event.preventDefault();
    const built = buildGenerationBody({ doctorId, startDate, weeks });
    if (!built.ok) return panel.setError(t.generateNeedsDate);
    // The response only carries a count: report it with the requested period.
    panel.setError(null);
    panel.setOk(null);
    const res = await panel.mutate(
      locale,
      () =>
        fetch(`${base}/schedule-generations`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: JSON_HEADERS,
          body: JSON.stringify(built.body),
        }),
      '',
    );
    if (!res) return;
    const generated = parseGenerated(await res.json().catch(() => null));
    if (generated === null) {
      panel.setOk(null);
      return panel.setError(t.actionFailed);
    }
    const values = {
      n: generated,
      from: formatLongDay(startDate, locale),
      to: formatLongDay(periodEnd(startDate, weeks), locale),
    };
    panel.setOk(
      fillTemplate(
        generated === 0
          ? t.generateNone
          : generated === 1
            ? t.generateDoneOne
            : t.generateDone,
        values,
      ),
    );
  }

  return (
    <section className="cs-card" aria-labelledby="cs-generate-title">
      <h2 id="cs-generate-title">{t.generateTitle}</h2>
      <p className="cs-help">{t.generateHelp}</p>
      <Messages {...panel} />
      <form className="cs-inline" onSubmit={onRun} noValidate>
        <div className="cs-field">
          <label htmlFor="cs-gen-start">{t.generateStart}</label>
          <input
            id="cs-gen-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className="cs-field">
          <label htmlFor="cs-gen-weeks">{t.generatePeriod}</label>
          <select
            id="cs-gen-weeks"
            value={weeks}
            onChange={(e) => setWeeks(Number(e.target.value))}
          >
            {GENERATION_WEEKS.map((w) => (
              <option key={w} value={w}>
                {w === 4 ? t.generateWeeks4 : t.generateWeeks8}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={panel.busy}>
          {t.generateRun}
        </Button>
      </form>
    </section>
  );
}

export function AbsencesSection({
  base,
  doctorId,
  locale,
  onForbidden,
}: Props) {
  const t = clinicSetupCopy[locale];
  const [days, setDays] = useState<string[] | null>(null);
  const [date, setDate] = useState('');
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const panel = usePanel(onForbidden, reload);
  const url = `${base}/doctors/${encodeURIComponent(doctorId)}/absences`;

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(url, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (res.status === 403) return onForbidden();
        const parsed = res.ok ? parseAbsences(await res.json()) : null;
        if (parsed) setDays(parsed);
        else panel.setError(t.sectionLoadError);
      } catch {
        if (!controller.signal.aborted) panel.setError(t.sectionLoadError);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, onForbidden]);

  function onAdd(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return panel.setError(t.absenceNeedsDate);
    void panel
      .mutate(
        locale,
        () =>
          fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: JSON_HEADERS,
            body: JSON.stringify({ absenceDate: date }),
          }),
        t.absenceAdded,
        t.absenceConflict,
      )
      .then((res) => {
        if (res) setDate('');
      });
  }

  return (
    <section className="cs-card" aria-labelledby="cs-absences-title">
      <h2 id="cs-absences-title">{t.absencesTitle}</h2>
      <p className="cs-help">{t.absencesHelp}</p>
      <Messages {...panel} />
      {days && days.length === 0 && <p>{t.absencesEmpty}</p>}
      {days && days.length > 0 && (
        <ul className="cs-list">
          {days.map((day) => (
            <li key={day} className="cs-row">
              <bdi>{formatLongDay(day, locale)}</bdi>
              <Button
                variant="secondary"
                disabled={panel.busy}
                onClick={() =>
                  void panel.mutate(
                    locale,
                    () =>
                      fetch(`${url}/${day}`, {
                        method: 'DELETE',
                        credentials: 'same-origin',
                      }),
                    t.absenceRemoved,
                  )
                }
              >
                {t.absenceRemove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="cs-inline" onSubmit={onAdd} noValidate>
        <div className="cs-field">
          <label htmlFor="cs-absence-date">{t.absenceDate}</label>
          <input
            id="cs-absence-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={panel.busy}>
          {t.absenceAdd}
        </Button>
      </form>
    </section>
  );
}
