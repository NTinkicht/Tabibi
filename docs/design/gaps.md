# UI design gap register

Every gap found while designing Tabibi's UI is recorded here with the issue that corrects it, so
none is lost between design, review and implementation. A gap is closed only when its issue is
closed by a merged PR (or the spec change that resolves it is merged). Update this file in the
PR that closes a gap.

Visual reference for all designs: https://claude.ai/artifact/RRe557S5McvDYnLFc7QLEm

| ID | Gap | Found in | Corrected by | Status |
|---|---|---|---|---|
| G-01 | No staff **restore** or **transfer** API, although `PRODUCT.md` TAB-P0-07 requires both and the console design uses them | reception console design | #810 | open |
| G-02 | Console status bar has no **Restore** and rows have no **Transfer** (blocked by G-01) | reception console design | #813 (after #810, #786) | open |
| G-03 | Staff dashboard had no appointment origin / start time for row metadata | Codex review of #784 | `reception-console.md` data prerequisite, implemented with #786 (`origin`, `appointmentStartsAt` in `ReceptionistDashboardEntry`) | closed |
| G-04 | Mockups showed browser-computed clock-time ETAs and called-at times the server does not provide | Codex review of #784 | specs use the canonical wait range; visual reference corrected (G-15) | closed |
| G-05 | No dedicated **tablet** layout for the reception console (deferred: device not confirmed) | reception console design | #814 (parked: owner decision + design) | open |
| G-06 | Doctors could not run queue commands or read the dashboard, needed by the doctor view | doctor view design | owner decision A in #799, PR #801 | closed |
| G-07 | Public waiting-room projection has no pause status, declared delay or `generatedAt` | waiting-room design | #811 | open |
| G-08 | Waiting-room page never refreshes and has no staleness signal, so a wall TV can show stale tickets as current | waiting-room design | #812 (after #811) | open |
| G-09 | Surfaces without an approved design: reception home, staff sign-in, notifications page, clinic setup, guest help pages | UI inventory 2026-11-08 | #815 (parked: design) | open |
| G-10 | Bookable sessions had no filters, location or specialties, so search could not show sessions; discovery is session-free by #692 | find-and-book design | #803 | closed |
| G-11 | An availability on/off toggle would have removed booking for available doctors (plain discovery has no session data) | Codex review of #802 | two explicit modes in `find-and-book.md`, implemented by #804 | open (until #804) |
| G-12 | `/guest/status` (status-only cookie) cannot check in or show a wait range; the two guest credential classes must not be mixed | Codex review of #797 | `patient-status.md` two-surfaces table, implemented by #798 | open (until #798) |
| G-13 | Cancelled and no-show must not read as "visit finished" | Codex review of #797 | `patient-status.md` terminal rows, implemented by #798 | open (until #798) |
| G-14 | The booking bearer is memory-only, so a closed page loses online access unless a contact link exists | find-and-book design | `find-and-book.md` keep-page-open notice, implemented by #805 | open (until #805) |
| G-15 | Visual reference still showed superseded details (clock-time ETAs, called-at times, availability checkbox) | spec reviews | canvas updated to match the specs on 2026-11-08 | closed |
