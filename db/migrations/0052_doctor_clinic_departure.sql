-- Gap register G-19 (TAB-P1-07): a doctor who leaves a clinic (membership
-- removed, or role changed away from doctor) is marked departed on the
-- clinic-doctor association instead of deleting it, so sessions, appointments
-- and audit history keep their references. Public discovery, bookable sessions
-- and new bookings require departed_at IS NULL; re-joining as a doctor clears it.
ALTER TABLE doctor_clinics
  ADD COLUMN departed_at timestamptz;
