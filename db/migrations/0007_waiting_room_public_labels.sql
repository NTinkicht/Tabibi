-- Work Unit 6: privacy-preserving waiting-room identifiers.
-- Public labels are deliberately independent from queue-entry IDs, patient identity,
-- contact data, registration/eligibility order, and guest credentials.

CREATE FUNCTION assign_privacy_safe_public_display_label()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate text;
BEGIN
  LOOP
    candidate := 'W-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    EXIT WHEN NOT EXISTS (
      SELECT 1
        FROM queue_entries
       WHERE session_id = NEW.session_id
         AND public_display_label = candidate
    );
  END LOOP;

  NEW.public_display_label := candidate;
  RETURN NEW;
END;
$$;

CREATE TRIGGER queue_entries_assign_public_display_label
BEFORE INSERT ON queue_entries
FOR EACH ROW
EXECUTE FUNCTION assign_privacy_safe_public_display_label();

COMMENT ON COLUMN queue_entries.public_display_label IS
  'Non-secret shared waiting-room label. Never use for authentication or derive from patient/internal identifiers.';

-- Backfill: every row that existed before this migration was assigned its
-- public_display_label by application code that derived it directly from the
-- queue entry's own UUID (CLAUDE-034). The trigger above only governs future
-- inserts, so regenerate every existing row's label with the same
-- collision-safe random generation, scoped per session, to close the gap for
-- any entry created before this migration runs.
DO $$
DECLARE
  entry RECORD;
  candidate text;
BEGIN
  FOR entry IN SELECT id, session_id FROM queue_entries ORDER BY id LOOP
    LOOP
      candidate := 'W-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
      EXIT WHEN NOT EXISTS (
        SELECT 1
          FROM queue_entries
         WHERE session_id = entry.session_id
           AND public_display_label = candidate
           AND id <> entry.id
      );
    END LOOP;
    UPDATE queue_entries SET public_display_label = candidate WHERE id = entry.id;
  END LOOP;
END;
$$;
