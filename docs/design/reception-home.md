# Reception home, staff sign-in and notifications — design specification

Status: approved by the owner on 2026-11-08. Builds on [`foundations.md`](foundations.md) and
uses the console header from [`reception-console.md`](reception-console.md).
Visual reference: https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm (row "Staff · reception
home, sign-in, notifications", French and Arabic). Gap register: G-09 (items 1–3), G-17.

## Reception home `/operations/[clinicId]` (`reception-desk.tsx`)

Data: `GET /api/clinics/{clinicId}/sessions?date=YYYY-MM-DD` → `sessions[]` (doctor display
name, `startsAt`/`endsAt`, `status`, `openedAt`/`closedAt`, `declaredDelayMinutes`, and
**`queueCounts`** `{ waiting, checkedIn, called, inConsultation, completed, noShow, cancelled }`,
G-17) plus the clinic `timezone`. Counts are aggregates only; doctors see only their own
sessions (existing scoping).

- Title "Sessions du jour" / "جلسات اليوم"; date control: previous day, `<input type="date">`,
  next day, "Aujourd’hui"; times rendered in the clinic time zone.
- Undelivered-notifications banner (when queue dead letters plus guest-link failures > 0, or
  when either source cannot be fetched: fail-safe) linking to the notifications page.
- Grid of session cards (`auto-fill, minmax(380px, 1fr)`): doctor + specialty, hours (20 px),
  status chip (planned = info tint, open = primary tint, paused = warning, closed = neutral,
  cancelled = danger tint), delay chip when declared, opened/closed time, a counts line
  ("4 arrivés · 2 pas encore · 1 appelé · 6 terminés"), and the actions for the status:
  open/paused → primary "Ouvrir la console" (to the session console) + Pause/Resume + Close;
  planned → primary "Ouvrir la session" + Cancel; closed/cancelled → "Voir le résumé".
  Close and cancel keep the existing confirmation + reason flow.
- Empty day: "Aucune session ce jour-là." with the date control still available.

## Staff sign-in `/staff/sign-in`

Centred 420 px card: logo, title, subtitle, error summary (`role="alert"`) using the existing
`signInStrings` messages (failed / rate-limited / unavailable / no clinic), identifier
(`autocomplete="username"`, `dir="ltr"`), password (`autocomplete="current-password"`), invalid
field outlined in danger, full-width primary submit (52 px), help line "Mot de passe oublié ou
compte verrouillé : demandez à l’administrateur de la clinique.", language switch under the card.
No change to the authentication flow, rate limiting or return-path handling.

## Notifications `/operations/[clinicId]/notifications`

Read-only, as today. Back link to the day's sessions; title and one-line explanation; a "Que
faire ?" box (tell the patient at reception, or issue a new status link from the patient's row in
the session console via the existing status-link action); two tables with real `<th scope="col">`
headers and horizontal scroll on narrow screens:

- queue notifications: event, ticket (`<bdi>`), reason category, attempts `n / max`, last
  failure time;
- status links: intent, state, ticket, attempts, last failure time.

Keep the existing strict allow-list: provider outcome text and contacts never reach the DOM;
privacy line at the bottom.

## Acceptance

Playwright fr/ar at 1440 px and 1024 px: home with every status, counts line, empty day,
notifications banner; sign-in each error state; notifications both tables and empty states;
keyboard-only navigation; screenshot baselines. API: `session-list-queue-counts.test.ts`.
