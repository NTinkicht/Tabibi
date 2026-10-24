-- TAB-P0-02 (#655): per-doctor absence days.
-- An absence is a clinic-local calendar day on which one associated doctor is
-- unavailable in one clinic. Session generation plans nothing for that doctor
-- in that clinic on that day, and manual session creation is rejected. There
-- is deliberately no free-text column (no reason), so an absence can never
-- carry personal data. Removing the doctor-clinic association removes it.
CREATE TABLE doctor_absences (
  clinic_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  absence_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, doctor_id, absence_date),
  FOREIGN KEY (clinic_id, doctor_id)
    REFERENCES doctor_clinics (clinic_id, doctor_id) ON DELETE CASCADE
);
