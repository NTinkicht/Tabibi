ALTER TABLE appointment_lifecycle_receipts
  DROP CONSTRAINT appointment_lifecycle_receipts_command_check;

ALTER TABLE appointment_lifecycle_receipts
  ADD CONSTRAINT appointment_lifecycle_receipts_command_check
    CHECK (command IN (
      'check_in',
      'cancel',
      'no_show',
      'complete_consultation'
    ));
