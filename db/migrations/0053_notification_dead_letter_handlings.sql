-- TAB-P1-06 (#871): staff record that a dead-lettered notification was handled
-- (for example by a manual call). One row per intent; it holds no free text and
-- no patient data, only who handled it and when. The outbox row itself stays
-- immutable.
CREATE TABLE notification_dead_letter_handlings (
  intent_id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL,
  handled_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  handled_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (intent_id, clinic_id)
    REFERENCES notification_outbox(id, clinic_id) ON DELETE RESTRICT
);

CREATE INDEX notification_dead_letter_handlings_clinic_idx
  ON notification_dead_letter_handlings (clinic_id);
