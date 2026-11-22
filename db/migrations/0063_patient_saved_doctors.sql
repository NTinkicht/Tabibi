-- TAB-P1-04 slice 1: patient-saved doctors. Operational bookmark only: the
-- owning patient account, the clinic and the doctor. No clinical data.
CREATE TABLE patient_saved_doctors (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL,
  doctor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, clinic_id, doctor_id),
  FOREIGN KEY (clinic_id, doctor_id)
    REFERENCES doctor_clinics (clinic_id, doctor_id) ON DELETE CASCADE
);

CREATE INDEX patient_saved_doctors_owner_time_idx
  ON patient_saved_doctors (owner_user_id, created_at DESC, clinic_id, doctor_id);

COMMENT ON TABLE patient_saved_doctors IS
  'Doctors bookmarked by an authenticated patient account; no clinical data.';
