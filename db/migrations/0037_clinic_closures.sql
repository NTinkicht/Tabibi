-- TAB-P0-02 (#638): clinic closure days (holidays).
-- A closure is a clinic-local calendar day on which session generation plans
-- nothing for any doctor of that clinic. There is deliberately no free-text
-- column, so a closure can never carry patient or staff personal data.
CREATE TABLE clinic_closures (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  closure_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, closure_date)
);
