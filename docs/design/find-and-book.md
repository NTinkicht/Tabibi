# Find a doctor and book — design specification

Status: approved by the owner on 2026-11-08. Builds on [`foundations.md`](foundations.md) and
hands off to [`patient-status.md`](patient-status.md).
Visual reference: https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm (row "Patient · find a
doctor and book": search, sessions, details, confirmation; the first artboard of each language
is a clickable flow). Serves `PRODUCT.md` TAB-P0-03 (discovery) and the guest booking rows.

Surfaces: the public home `/` (`PublicDiscoveryLandingClient`, server-rendered) for search,
results and a doctor's sessions; the existing booking step of
`/guest/live-queue/[selectionReference]` (`GuestLiveQueueHostClient`) for details and
confirmation. No account, no new authority.

## Data prerequisite: filtered bookable sessions (public, privacy-minimal)

Today discovery (`GET /api/public/discovery`) has the filters (`wilaya`, `specialty`,
`language`, `available`, `page`) and the clinic location / doctor specialties, but by decision
#692 it carries **no session data**. Bookable sessions (`GET /api/public/bookable-sessions`) carry
sealed `selectionReference`s within the 14-day horizon, but take no filters and lack location and
specialties. To render "next session" and a doctor's sessions without inventing data:

- `GET /api/public/bookable-sessions` accepts the same optional filters as discovery (validated by
  the same `parseDiscoveryFilters` rules; unknown codes → 400) and pagination;
- each clinic adds `wilayaCode`, `commune`, `addressLine`; each doctor adds `specialtyCodes`
  (exactly the values discovery already publishes);
- nothing else is added: no ids, contacts, capacity, queue length or patient data;
- tests: the public allow-list test is updated **explicitly** for the new fields and their exact
  shape; filters return only matching clinic-doctor pairs; a no-identifier-leak test covers the
  response; discovery stays session-free (#692 unchanged).

The UI uses bookable sessions when "only with available sessions" is on (the default) and plain
discovery when it is off; doctors without bookable sessions then show "Pas de session réservable
en ligne pour l’instant" / "لا توجد جلسة قابلة للحجز عبر الإنترنت حاليًا" and no button.

## Screens (phone first, 360–430 px; ≤ 720 px centred column on desktop)

1. **Search** (`/`): title "Trouver un médecin" / "ابحث عن طبيب"; filter card with specialty and
   wilaya `<select>`s (labels from `specialties.ts` / `wilayas.ts`, wilaya shown as
   `09 · Blida`), doctor-language segmented control (Toutes / العربية / Français), checkbox
   "Seulement avec des sessions disponibles" (default on); result count; clinic cards (name,
   commune · wilaya, address line, languages) listing doctors with specialty chips, "Prochaine
   session : …" from the earliest bookable session, and primary "Voir les sessions". Server
   render the first page (as today); "Plus de résultats" loads the next page. Footer note:
   information comes from clinics; no patients or private contacts are shown.
2. **Doctor sessions** (same page, client state; back button mirrors in RTL): doctor, specialty,
   clinic line; list of that doctor's bookable sessions (day + hours), each with "Réserver" →
   navigates to `/guest/live-queue/{selectionReference}`; note that the patient books a place in
   a session, not an exact time, and that the arrival time appears after booking.
3. **Details** (booking step of the live-queue host): "Votre choix" summary; name (with hint:
   visible only to the clinic, never on the tracking page); message language segmented control;
   contact preference segmented control (Aucun / Téléphone / E-mail) with the matching input
   (`dir="ltr"`); an explanation that changes with the choice (no contact still gets full
   in-clinic service but tracking only through this page); primary "Réserver ma place"
   disabled until valid; link to `/guest/privacy-help`. Maps 1:1 to `POST /api/public/bookings`
   (`privateDisplayName`, `preferredLocale`, `contactPreference`, `contactPhone`/`contactEmail`).
4. **Confirmation**: "Réservé" chip, `queueLabel` (48 px `<bdi>`), doctor, session, clinic; line
   that the suggested arrival time appears on the tracking page; amber **keep-this-page-open**
   notice that matches the contact choice (phone/e-mail: the received link brings you back;
   none: this page is the only online access, give your number at reception); primary "Suivre
   mon passage" → the live-status panels of `patient-status.md`; "Annuler ma réservation" →
   existing cancellation flow.

The booking bearer stays in memory exactly as today (never URL, storage or logs); the
keep-open notice is the honest consequence and must not be removed or softened.

## Copy

All strings are in the visual reference (FR and AR); add them to the public discovery and guest
booking localization modules. Specialty and wilaya names come only from the versioned code lists.

## Accessibility

Real `<select>`, `<label>`, `<fieldset>/<legend>` and `aria-pressed` buttons; 48 px controls;
result count announced on change; works at 200 % zoom at 360 px without horizontal scroll.

## Acceptance

- API: the filtered bookable-sessions tests above (allow-list exact shape, filter semantics,
  no-leak, 400 on bad codes, horizon unchanged).
- Playwright fr/ar at 390 × 844 and 1280 px: filters, available on/off, sessions → booking
  route, details validation per contact choice, confirmation notice per contact choice,
  RTL mirroring of back navigation, screenshot baselines.
- Existing discovery SSR, booking, idempotency and bearer-handling tests keep passing unchanged.
