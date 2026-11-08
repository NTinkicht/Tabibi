# Reception console — design specification

Status: approved by the owner on 2026-11-08. Builds on [`foundations.md`](foundations.md).
Visual reference: https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm (artboards
"Accueil — français" and "الاستقبال — العربية"; press Play to try the flows).
Serves `PRODUCT.md` TAB-P0-07 (reception operations UI) and TAB-P0-14 (Arabic RTL / French LTR,
accessibility, responsive).

The console replaces the current session queue page
(`/operations/[clinicId]/sessions/[sessionId]/queue`) with one screen per doctor session that
combines session control, the patients being served, the queue and walk-in registration.
It uses existing staff APIs plus one small staff-only projection extension (below); it
introduces no new authority and no client-side state that is not confirmed by the server.

## Data prerequisite: dashboard projection extension

The session dashboard (`ReceptionistDashboardEntry`, `GET …/sessions/{id}/dashboard`) already
gives `state`, orders, `publicDisplayLabel`, `privateDisplayName`, `preferredLocale`,
`hasContact`, `activeConsultationRemainingMinutes` and the canonical `eta` wait range. It does
**not** say whether an entry is appointment-backed or when the appointment starts, and the staff
queue list (`StaffQueueEntry`) does not either. Before rendering appointment metadata the
implementation must add, in the same PR or a preceding one:

- `origin: 'appointment' | 'walk_in'` and `appointmentStartsAt: string | null` (ISO, clinic
  time zone applied only for display) on `ReceptionistDashboardEntry`, derived server-side from
  the linked appointment;
- clinic-scoped tests: staff of another clinic cannot read it (existing cross-tenant matrix
  covers the route), contact-less and walk-in entries return `walk_in` / `null`, and **no public
  or guest projection gains these fields**.

Until that lands, rows omit the appointment part of the meta and waiting rows show no
appointment caption; nothing is inferred in the browser.

## Layout (desktop ≥ 1200 px, max width 1440 px)

```
┌ Header: logo · clinic · date/time · [Français | العربية] · staff ─────────────────┐
├ Session bar: doctor + specialty + hours │ session chip │ − delay + │ Pause · Close │ [Call next · A-013 Yacine Haddad] ┤
├ (paused banner)  (last-action status bar) ────────────────────────────────────────┤
│ Main column (flex 999 1 640px)                  │ Side panel (flex 1 1 320px)      │
│  "In progress": cards for in_consultation,      │  Add a patient (walk-in form)     │
│   then called                                   │  Today: 4 stat tiles              │
│  "Queue": one list — checked_in in service      │  Undelivered notifications alert  │
│   order, then waiting (appointments not yet     │  Bulk no-show for appointments    │
│   arrived, by appointment time)                 │                                   │
│  terminal summary line                          │                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

Below 1200 px the side panel wraps under the main column (flex-wrap; no media-query
breakpoints needed for that). Below 700 px queue rows wrap their cells onto two lines and the
session bar stacks. Tablet layout (1024 × 768, landscape) is the next design iteration; it must
not require horizontal scrolling.

## Regions and behaviour

| Region | Content | Server source / command | Rules |
|---|---|---|---|
| Session bar | doctor, specialty, hours, session state chip | session dashboard `GET …/sessions/{id}/dashboard` (the console's single read model) | chip: open = primary tint, paused = warning tint |
| Delay control | `−` / value / `+` in 5-minute steps, 0–720 | `…/sessions/{id}/delay` | value is the committed delay; buttons send the new total; show "Aucun retard"/"لا يوجد تأخير" at 0 |
| Pause / Resume, Close session | secondary / danger buttons | `…/sessions/{id}/commands` | close and cancel require the existing confirmation + reason flow |
| Call next | large primary button naming the next callable entry (`ticket · name`) | entry `commands` `call` on the first `checked_in` of the displayed service order (`selectNextCallableEntry`) | disabled (with the paused banner) when the session is paused or nobody is callable |
| Paused banner | warning banner | session status | text: calls are suspended; check-in and completing the current consultation still work (matches `queueCommandSessionGate`) |
| In progress | one card per `in_consultation` (first) and `called` entry: state chip, ticket (30 px), name, meta; in_consultation adds "≈ N min restantes" from `activeConsultationRemainingMinutes` when present | dashboard | in_consultation → primary "Terminer la consultation"; called → primary "Démarrer la consultation" (disabled while paused) + ⋯ panel with no-show / cancel |
| Queue list | rows: position, ticket, name (+ "Suivant" badge on the first callable, "Prioritaire" badge), meta, wait caption + range, state chip, primary action, ⋯ | dashboard (entries + canonical `eta`) | order = `QUEUE_DISPLAY_STATE_RANK` then service order; never re-sort on the client beyond that contract |
| Row primary action | waiting → "Enregistrer l’arrivée" (secondary); checked_in → "Appeler" (primary on the first row, secondary on others; disabled while paused) | entry `commands` `check_in` / `call` | exactly the `QUEUE_COMMAND_SOURCE_STATES` table |
| Row ⋯ panel | reason input + Prioritise (waiting/checked_in, not already priority) + Absent (checked_in/called) + Cancel (waiting/checked_in/called) + audit hint | `reorder` (position 1 of the priority cohort) / `commands` `no_show` / `cancel` | buttons disabled until the reason is non-empty; one panel open at a time; Esc or ⋯ closes it |
| Status bar | "A-013 Yacine Haddad : Appelé." after each committed command | command response | **Restore button only once a restore API exists** (TAB-P0-07 restore); until then the bar has no button |
| Add a patient | name (required), phone (optional, `dir="ltr"`), patient language segmented control (default = UI language), checkbox "Le patient est là : enregistrer son arrivée tout de suite" (default on), primary "Ajouter à la file" | queue `POST` (creates `waiting`), then entry `commands` `check_in` when the checkbox is on | if check-in fails after creation, the entry stays `waiting` and the status bar says so; contact hint text always visible |
| Today | 4 tiles: arrived, not yet arrived, completed, no-show | dashboard | numbers only from the server |
| Notifications alert | shown only when undelivered notifications > 0; links to `/operations/{clinicId}/notifications` | notifications dead-letters | warning tint card |
| Bulk no-show | title, explanation, secondary button opening the existing confirmation flow | `appointments/bulk-no-show` | unchanged rules; never touches arrived or walk-in patients |

Row meta format: `Rendez-vous 10:00 · Téléphone enregistré · Arabe` /
`موعد 10:00 · الهاتف مسجّل · العربية`; walk-ins show `Sans rendez-vous` / `بدون موعد`;
no contact shows `Sans coordonnées` / `بدون معلومات اتصال`.

Wait column: checked_in rows show "Attente estimée" / "الانتظار المتوقع" with the canonical range
`eta.minWaitMinutes`–`eta.maxWaitMinutes` ("≈ 10–25 min"; a single value when equal; "—" when
`eta` is null). The browser never converts it to a clock time or recomputes it. Waiting rows with
an appointment show "Rendez-vous 10:40" from `appointmentStartsAt` (see Data prerequisite).

The visual reference was updated on 2026-11-08 to show range estimates and no called-at time
(gap register G-04, G-15); this specification remains the source of truth.

## Copy

Reuse the strings in `src/modules/localization/receptionist.ts`. New keys needed (FR / AR):

| Key | Français | العربية |
|---|---|---|
| `callNext` | Appeler le suivant | نداء التالي |
| `noneToCall` | Personne à appeler | لا أحد للنداء |
| `servingTitle` | En cours | الجارية الآن |
| `emptyServing` | Aucun patient en consultation. Appelez le suivant pour commencer. | لا يوجد مريض في الاستشارة. نادِ التالي للبدء. |
| `nextChip` | Suivant | التالي |
| `priorityBadge` | Prioritaire | أولوية |
| `pausedBanner` | Session en pause : les appels sont suspendus. Vous pouvez toujours enregistrer les arrivées et terminer la consultation en cours. | الجلسة متوقفة مؤقتًا: النداء معلّق. يمكنك مواصلة تسجيل الوصول وإنهاء الاستشارة الجارية. |
| `presentNow` | Le patient est là : enregistrer son arrivée tout de suite | المريض حاضر: سجّل وصوله فورًا |
| `addToQueue` | Ajouter à la file | إضافة إلى القائمة |
| `auditedHint` | Ces actions sont enregistrées dans le journal d’audit avec votre nom et le motif. | تُسجَّل هذه الإجراءات في سجل التدقيق مع اسمك والسبب. |
| `waitEstimate` | Attente estimée | الانتظار المتوقع |
| `waitRange` | ≈ {min}–{max} min | ≈ {min}–{max} دقيقة |
| `remainingConsult` | ≈ {n} min restantes | ≈ {n} دقيقة متبقية |
| `lastAction` | {ticket} {name} : {state}. | {ticket} {name}: {state}. |
| `queueCount` | {a} arrivés · {w} pas encore arrivés | {a} حاضرون · {w} لم يصلوا بعد |
| `notArrived` (state label for `waiting` in this view) | Pas encore arrivé | لم يصل بعد |

## Accessibility

- Landmarks: `header`, `main`, `aside`; each region is a `section` with a visible `h2`.
- Queue is a list (`role="list"` / `listitem`); every ⋯ button has `aria-label`
  "Plus d’actions pour A-013" / "إجراءات أخرى لـ A-013" and `aria-expanded`.
- Status bar and paused banner use `role="status"`; delay value is `aria-live="polite"`.
- Keyboard: every action reachable with Tab; planned shortcuts (N = add patient focus,
  A = call next, Esc = close panel) only once they are scoped to the console and listed in
  the UI.

## Acceptance (for the implementing PRs)

- Playwright, both locales (`fr` LTR, `ar` RTL) at 1440 px and 1024 px: session bar, call next,
  in-progress cards, queue order, ⋯ panel with reason gating, walk-in with "present now",
  paused state disabling call/start but not check-in/complete; RTL mirroring
  (side panel on the left in Arabic), no horizontal scroll at 1024 px.
- Axe (or equivalent) with no serious/critical violations; keyboard-only run of check-in → call →
  start → complete.
- Projection tests for `origin` / `appointmentStartsAt` as listed under Data prerequisite.
- API-backed tests: every button maps to exactly one existing command and renders only the
  committed result; command rejection (409/403/stale) leaves the row unchanged and shows the
  error; no browser-side ETA or ordering logic beyond the display contract.
- Screenshot baselines for both locales are committed so later PRs cannot silently break the
  layout.
