# UI design gap register

Every gap found while designing Tabibi's UI is recorded here with the issue that corrects it, so
none is lost between design, review and implementation. A gap is closed only when its issue is
closed by a merged PR (or the spec change that resolves it is merged). Update this file in the
PR that closes a gap.

Visual reference for all designs: https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm

| ID | Gap | Found in | Corrected by | Status |
|---|---|---|---|---|
| G-01 | No staff **restore** or **transfer** API, although `PRODUCT.md` TAB-P0-07 requires both and the console design uses them | reception console design | #810 | closed |
| G-02 | Console status bar has no **Restore** and rows have no **Transfer** (blocked by G-01) | reception console design | #813 (after #810, #786) | open |
| G-03 | Staff dashboard had no appointment origin / start time for row metadata | Codex review of #784 | `reception-console.md` data prerequisite, implemented with #786 (`origin`, `appointmentStartsAt` in `ReceptionistDashboardEntry`) | closed |
| G-04 | Mockups showed browser-computed clock-time ETAs and called-at times the server does not provide | Codex review of #784 | specs use the canonical wait range; visual reference corrected (G-15) | closed |
| G-05 | No dedicated **tablet** layout for the reception console (deferred: device not confirmed) | reception console design | tablet design approved 2026-11-08 (`reception-console.md` → Tablet); implementation: #821 | open (until #821) |
| G-06 | Doctors could not run queue commands or read the dashboard, needed by the doctor view | doctor view design | owner decision A in #799, PR #801 | closed |
| G-07 | Public waiting-room projection has no pause status, declared delay or `generatedAt` | waiting-room design | #811 | closed |
| G-08 | Waiting-room page never refreshes and has no staleness signal, so a wall TV can show stale tickets as current | waiting-room design | #812 (after #811) | open |
| G-09 | Surfaces without an approved design: reception home, staff sign-in, notifications page, clinic setup, guest help pages | UI inventory 2026-11-08 | items 1–3 designed 2026-11-08 (`reception-home.md`), implemented: #822 (PRs #842 and this one); clinic setup designed 2026-11-08 (`clinic-setup.md`), implementation: #829, #830; guest help pages restyled with the foundations (no bespoke design): #831 | open (until #822, #829, #830, #831) |
| G-10 | Bookable sessions had no filters, location or specialties, so search could not show sessions; discovery is session-free by #692 | find-and-book design | #803 | closed |
| G-11 | An availability on/off toggle would have removed booking for available doctors (plain discovery has no session data) | Codex review of #802 | two explicit modes in `find-and-book.md`, implemented by #804 | open (until #804) |
| G-12 | `/guest/status` (status-only cookie) cannot check in or show a wait range; the two guest credential classes must not be mixed | Codex review of #797 | `patient-status.md` two-surfaces table, implemented by #806, #807, #835 | closed |
| G-13 | Cancelled and no-show must not read as "visit finished" | Codex review of #797 | `patient-status.md` terminal rows, implemented by #806, #807, #835 | closed |
| G-14 | The booking bearer is memory-only, so a closed page loses online access unless a contact link exists | find-and-book design | `find-and-book.md` keep-page-open notice, implemented by #805 | open (until #805) |
| G-15 | Visual reference still showed superseded details (clock-time ETAs, called-at times, availability checkbox) | spec reviews | canvas updated to match the specs on 2026-11-08 | closed |
| G-16 | The doctor must be able to replace any patient by any other one (reorder), which #799 option A had kept reception-only | owner request 2026-11-08 | permission: #817 (PR #820, merged); doctor-view reorder design approved 2026-11-08 (`doctor-view.md`), UI: #819 | open (until #819) |
| G-17 | The staff session list had no per-session queue counts for the reception home cards | reception home design | `queueCounts` aggregates in `GET /api/clinics/{clinicId}/sessions` (this PR, `session-list-queue-counts.test.ts`) | closed |
| G-18 | Staff invites (`StaffInviteService`) had no API route and no accept page, so a clinic could not onboard staff from the product | clinic setup design | #824 (PR #827): admin create/list/revoke routes, public preview/accept routes, `/staff/invite#<token>` page; Personnel tab UI: #830 | open (API merged; until #830) |
| G-19 | No way to remove a person's access; a doctor whose role changed stayed publicly discoverable and bookable | clinic setup design | #825 (PR #826): `DELETE …/memberships/{userId}` and the `doctor_clinics.departed_at` marker (migration 0052) gating discovery, bookable sessions, selection, booking, the staff doctor list and session planning; UI: #830 | open (API merged; until #830) |
| G-20 | The staff list returned only `userId` and `role`, but the Personnel screen shows each member's name and sign-in identifier | clinic setup spec | PR #828 (`displayName`, `identifier` in `GET …/memberships`), merged | closed |
| G-21 | Clinic setup artboards showed capabilities the product does not have: e-mail sending of invites (zero additional spend) and a stored "sessions generated until" date | clinic setup spec | `clinic-setup.md`: "Créer le lien d’invitation" with a one-time copyable link, and an honest count-and-period message after generation; implemented by #829, #830 | open (until #829, #830) |
