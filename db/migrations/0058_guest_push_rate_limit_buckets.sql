-- Dedicated counters for the guest push routes. They include a one-hour
-- window (resend), so they must not share guest_status_rate_limit_buckets,
-- whose other users purge every bucket older than their 60-second window.
CREATE TABLE guest_push_rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX guest_push_rate_limit_buckets_window_idx
  ON guest_push_rate_limit_buckets(window_started_at);
