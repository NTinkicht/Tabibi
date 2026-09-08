ALTER TABLE queue_entries
  VALIDATE CONSTRAINT queue_entries_source_check_wu11_tmp;

ALTER TABLE queue_entries
  RENAME CONSTRAINT queue_entries_source_check_wu11_tmp
  TO queue_entries_source_check;

ALTER TABLE audit_events
  VALIDATE CONSTRAINT audit_events_entity_type_check_wu11_tmp;

ALTER TABLE audit_events
  RENAME CONSTRAINT audit_events_entity_type_check_wu11_tmp
  TO audit_events_entity_type_check;
