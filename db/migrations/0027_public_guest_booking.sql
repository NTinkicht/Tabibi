-- WU59: durable convergence boundary for unauthenticated guest appointment booking.

ALTER TABLE appointments
  ADD CONSTRAINT appointments_source_check_wu59_tmp
    CHECK (source IN ('staff', 'public')) NOT VALID;

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_source_check;

ALTER TABLE appointments
  RENAME CONSTRAINT appointments_source_check_wu59_tmp TO appointments_source_check;

ALTER TABLE appointments
  VALIDATE CONSTRAINT appointments_source_check;

-- Public booking events have no authenticated account actor. Existing staff
-- events remain populated; NULL is reserved for explicitly unauthenticated
-- system/public actions whose source is captured in privacy-safe metadata.
ALTER TABLE audit_events
  ALTER COLUMN actor_user_id DROP NOT NULL;

CREATE TABLE public_guest_booking_receipts (
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
  patient_id uuid,
  queue_entry_id uuid,
  appointment_id uuid,
  credential_id uuid,
  access_ciphertext text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, idempotency_key),
  FOREIGN KEY (patient_id, clinic_id)
    REFERENCES patient_operational_records(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (queue_entry_id, clinic_id)
    REFERENCES queue_entries(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (appointment_id, clinic_id)
    REFERENCES appointments(id, clinic_id) ON DELETE RESTRICT,
  FOREIGN KEY (credential_id, clinic_id)
    REFERENCES guest_credentials(id, clinic_id) ON DELETE RESTRICT,
  CHECK (
    (completed_at IS NULL AND patient_id IS NULL AND queue_entry_id IS NULL
      AND appointment_id IS NULL AND credential_id IS NULL AND access_ciphertext IS NULL)
    OR
    (completed_at IS NOT NULL AND patient_id IS NOT NULL AND queue_entry_id IS NOT NULL
      AND appointment_id IS NOT NULL AND credential_id IS NOT NULL AND access_ciphertext IS NOT NULL)
  )
);

CREATE UNIQUE INDEX public_guest_booking_receipts_appointment_uq
  ON public_guest_booking_receipts (appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE UNIQUE INDEX public_guest_booking_receipts_credential_uq
  ON public_guest_booking_receipts (credential_id)
  WHERE credential_id IS NOT NULL;

COMMENT ON COLUMN public_guest_booking_receipts.access_ciphertext IS
  'Server-encrypted replay copy of the guest bearer. Never expose through staff/public projections or logs.';
