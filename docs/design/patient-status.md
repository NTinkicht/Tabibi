# Patient live-queue status — design specification

Status: approved by the owner on 2026-11-08. Builds on [`foundations.md`](foundations.md).
Visual reference: https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm (row "Patient · live queue
status": not arrived, in the queue, called; the Tweaks "scenario" control also shows paused and
done). Serves `PRODUCT.md` TAB-P0-14 and the guest live-status rows.

This is a **presentation redesign** of the existing booking live-queue page
(`src/app/guest/live-queue/[selectionReference]/GuestLiveQueueHostClient.tsx`) and, with the same
components, the guest status page (`src/app/guest/status`). The data flow, polling/SSE, stale
and out-of-order protection, and the explicit check-in request stay exactly as they are; no new
API, field or permission.

## Data (unchanged allow-lists)

Only what the public projections already return: `publicDisplayLabel`, `queueState` /
`bookingState`, `positionKind` (`provisional` | `live`), `patientsAhead`, `eta`
(`minWaitMinutes`, `maxWaitMinutes`, `delayStatus`, `uncertainty.countdownEligible`),
`arrivalWindow` (`earliestAt`, `latestAt`, `basis`), `pauseStatus`, `closureStatus`,
`session.declaredDelayMinutes`, terminal `finalStatus`, `generatedAt`. The page never shows the
patient's name, phone, doctor name or clinic identifiers, and says so in its footer.
Allow-list and no-identifier-leak tests must not be loosened.

## Layout (phone first, 360–430 px; centred column ≤ 480 px on larger screens)

1. Header: logo, language switch (`FR` / `عربي`).
2. Ticket card: "Votre numéro" / "رقمك", ticket in 40 px `<bdi>`, state chip on the end side.
3. One state panel (below).
4. "Mis à jour il y a 20 s" / "آخر تحديث قبل 20 ثانية" from `generatedAt` (hidden when terminal).
5. Footer: links to `/guest/eta-explained` and `/guest/help`; privacy line.

## State panels

| Condition | Chip | Panel |
|---|---|---|
| booking not arrived (`positionKind = provisional`) | Pas encore arrivé(e) / لم تصل بعد | suggested arrival window `earliestAt – latestAt` (30 px, clinic time zone), basis sentence, provisional-position note, primary **"Je suis arrivé(e) à la clinique"** → inline confirmation ("Confirmez seulement si vous êtes déjà dans la clinique." + "Confirmer mon arrivée" / "Pas encore") → existing `POST /api/public/bookings/check-in` |
| live (`checked_in`) | Dans la file / في القائمة | `patientsAhead` (56 px) + "patients avant vous"; "Attente estimée ≈ min–max min"; amber delay notice when `delayStatus = declared`; "stay near reception" line; after a successful check-in a success status line |
| paused (`pauseStatus = paused`) | En pause / متوقف مؤقتًا | warning panel: consultations suspended, place kept, `patientsAhead` still shown, "Estimation suspendue pendant la pause" (no countdown; honours `countdownEligible = false`) |
| called | Appelé(e) / حان دورك | full primary panel: "C’est votre tour" / "حان دورك", go to reception, ticket repeated (44 px); `role="status"` |
| terminal | Terminé / انتهت | "Votre visite est terminée" + page no longer updates |
| closed session, rejected/expired link, network error | (existing messages) | existing copy in the new card style; never a fabricated estimate |

The confirmation step is mandatory: arrival is never inferred from location, time or page
visits. Ranges collapse to one value when `min = max`; "—" when `eta` is null.

## Copy

New FR/AR strings are listed in the visual reference; add them to the guest localization
module next to the existing live-queue strings (e.g. `imHere`, `confirmArrivalQuestion`,
`confirmArrival`, `notYet`, `arrivalConfirmed`, `patientsAheadSuffix`, `waitEstimate`,
`delayDeclaredNotice`, `stayNearReception`, `pausedTitle`, `pausedBody`, `estimatePaused`,
`yourTurn`, `goToDeskWithNumber`, `visitFinished`, `noLongerUpdates`, `updatedAgo`,
`privacyFooter`).

## Accessibility

- State panel changes are announced (`role="status"` on the panel; no repeated announcements on
  identical polls).
- 56 px primary button, 48 px confirmation buttons; contrast per tokens; works at 200 % zoom
  without horizontal scroll at 360 px.

## Acceptance

- Playwright (fr LTR, ar RTL, 390 × 844 and 360 × 740): each panel from fixture responses,
  the two-step check-in (cancel and confirm paths), stale/out-of-order responses never regress
  the panel (existing tests keep passing), screenshot baselines committed.
- Allow-list tests unchanged and passing; a test asserts the rendered page contains no
  name/phone/doctor/clinic identifier from the fixture.
