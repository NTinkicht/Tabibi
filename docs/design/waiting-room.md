# Waiting-room TV display — design specification

Status: approved by the owner on 2026-11-08. Builds on [`foundations.md`](foundations.md).
Visual reference: https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm (row "Waiting room · TV
display": normal, paused + declared delay, out-of-date). Serves `PRODUCT.md` TAB-P0-14 and the
public waiting-room display. Gaps found while designing it are tracked in [`gaps.md`](gaps.md)
(G-07, G-08).

Surface: `/waiting-room/[clinicId]/[sessionId]` on a wall screen (16:9, viewed from 2–6 m).
Public and unauthenticated: it shows **only public ticket labels**; never names, contacts,
consultation details, doctor or clinic identifiers.

## Data prerequisite (G-07, #811)

Today `GET /api/public/clinics/{clinicId}/sessions/{sessionId}/waiting-room` returns
`entries[]` of `{ publicDisplayLabel, state: waiting | checked_in | called, called }` in canonical
display order. The design also needs, from the server and already public in the guest status
projections: `session.pauseStatus`, `session.declaredDelayMinutes` and a `generatedAt`
timestamp. Nothing else is added; the allow-list test is updated explicitly.

## Layout (1920 × 1080; scales down to 1280 × 720)

- **Header** (120 px): logo, "قاعة الانتظار" + "Salle d’attente", live/offline indicator, clock.
- **Paused/delay banner** (only when paused or a delay is declared), warning tint, both languages.
- **Called panel** (3/5 width, solid primary, white text): "تم النداء" / "Appelé", the called
  ticket at ~300 px (`<bdi>`), "توجّه إلى الاستقبال" / "Présentez-vous à l’accueil". If several
  entries are called, show the most recent large and the others smaller beneath; none called →
  "Pas encore d’appel" / "لا يوجد نداء بعد".
- **Next panel** (2/5): "الأدوار التالية" / "Prochains", the next five `checked_in` labels in
  display order (first highlighted), then counts only: "+ N autres patients arrivés" and
  "N rendez-vous pas encore arrivés" (`waiting` entries are counted, never listed).
- **Footer**: "Seuls les numéros de passage sont affichés · Suivez votre passage sur votre
  téléphone" in both languages.

Bilingual by default (Arabic and French together; Arabic text uses Plex Sans Arabic with
`lang="ar" dir="rtl"` spans). `?lang=ar|fr` keeps a single-language mode.

## Refresh and honesty (G-08, #812)

- Poll the public API every 15 s (exponential backoff on errors, max 60 s); no full-page reloads.
- **Stale rule:** if no successful response for 60 s, cover the content with the out-of-date
  overlay ("العرض غير محدَّث منذ HH:MM" / "Affichage non à jour depuis HH:MM", "ask at
  reception"), using the last successful `generatedAt`, and switch the indicator to offline.
  Remove it on the next success. Never show stale tickets as current.
- Respect `prefers-reduced-motion`; a newly called ticket may get a brief highlight only.

## Accessibility and legibility

Minimum 26 px text at 1080p, contrast per tokens; the called panel is `aria-live="assertive"`
for screen-reader kiosks; no interactive controls.

## Acceptance

Playwright at 1920 × 1080 and 1280 × 720: normal, several called, none called, paused + delay,
empty session, stale overlay after simulated network failure and recovery; DOM contains no
names/contacts/doctor/clinic identifiers; allow-list and no-leak tests for the projection;
screenshot baselines.
