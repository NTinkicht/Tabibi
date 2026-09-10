CREATE TABLE guest_status_rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX guest_status_rate_limit_buckets_window_idx
  ON guest_status_rate_limit_buckets(window_started_at);
