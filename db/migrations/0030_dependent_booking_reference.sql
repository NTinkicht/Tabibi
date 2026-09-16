ALTER TABLE appointments
  ADD COLUMN dependent_id uuid;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_dependent_id_fkey
  FOREIGN KEY (dependent_id)
    REFERENCES patient_dependents(id) ON DELETE RESTRICT;

CREATE INDEX appointments_dependent_time_idx
  ON appointments (dependent_id, scheduled_start_at)
  WHERE dependent_id IS NOT NULL;

COMMENT ON COLUMN appointments.dependent_id IS
  'Optional account-owned dependent selected as the booking subject. Ownership and active eligibility are authorized transactionally before persistence; the identifier is not serialized in booking responses.';
