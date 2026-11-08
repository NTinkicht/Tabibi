# Doctor view (phone) — design specification

Status: design approved by the owner on 2026-11-08. Builds on [`foundations.md`](foundations.md).
Visual reference: https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm (row "Doctor · phone").
Serves `VISION.md` "Doctor experience" (personal queue view, one-click
call-next/start/complete, temporary pause) and `PRODUCT.md` TAB-P0-14.

## Authorization prerequisite (not yet granted)

Today a `doctor` may run **session** commands (open/pause/resume/close, delay) on sessions of
their own doctor identity (`requireSessionAccess` → `requireDoctorIdentity`), but **queue**
commands (`call`, `start_consultation`, `complete_consultation`, `no_show`) and the session
dashboard read are limited to `receptionist` and `clinic_admin`. The doctor view needs:

- `doctor` allowed for `call`, `start_consultation`, `complete_consultation` and `no_show` on
  entries of sessions whose doctor is the caller's own doctor identity in the same clinic, with
  the same CAS/version, doctor-global lock, idempotency, reason and audit rules as reception;
- a doctor-scoped read of the session dashboard for those sessions only;
- **reorder** of their own session's waiting/arrived patients (owner decision #817, reason
  required, audited), so the doctor can replace the next patient by any other one;
- no other widening: no check-in, walk-in creation, cancel, bulk no-show, other doctors'
  sessions, or other clinics;
- cross-tenant and cross-doctor denial tests (extending the route matrix), audit actor = doctor.

This is a widening of authorization and therefore an **owner decision** (tracked as an
`l5:owner` issue). The UI below must not ship before it is granted and merged.

## Layout (phone, 360–430 px)

1. Header: doctor name, specialty and session hours; Pause/Resume toggle (`aria-pressed`);
   session chip and the ±5-minute delay control.
2. Paused banner when paused (completing the current consultation still works; call/start do not).
3. Current card: "En consultation" (solid chip, ticket 34 px, name, meta, "≈ N min restantes
   (estimation)" from `activeConsultationRemainingMinutes`) or "Appelé, en route vers vous" or
   "Aucun patient en consultation".
4. One large primary button (≥ 76 px) whose action follows the state:
   in consultation → **Terminer la consultation**; called → **Démarrer la consultation**
   (+ ticket · name); otherwise → **Appeler le suivant** (+ next ticket · name, from
   `selectNextCallableEntry`); nobody callable → disabled "Personne à appeler".
5. When a patient is called: secondary "Le patient ne se présente pas" → inline reason panel
   (reason required) → no-show.
6. "Ensuite": up to four next callable entries with name, meta and canonical wait range;
   "N pas encore arrivés".
7. Footer line: today's completed / no-show counts.

Every button issues exactly one existing command and renders only the committed result; a
rejected command (409 stale, 403, lock conflict) leaves the screen unchanged and shows the
error. No client-side ETA or ordering.

## Copy

FR/AR strings as in the visual reference (`complete`, `start`, `callNext`, `noneToCall`,
`inConsultTitle`, `calledTitle`, `remaining`, `noShowAsk`, `noShowConfirm`, `nextTitle`,
`notArrived`, `today`); reuse receptionist strings where identical.

## Acceptance

- Authorization tests first (see prerequisite), then Playwright for both locales at 390 × 844:
  the complete → start → call next loop, paused gating, no-show reason gating, rejection
  handling, screenshot baselines.
