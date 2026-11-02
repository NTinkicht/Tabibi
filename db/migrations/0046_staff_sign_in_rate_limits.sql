-- TAB-P0-01 (#725): sign-in throttling buckets live in their own table so the
-- guest routes' opportunistic cleanup of guest_status_rate_limit_buckets can
-- never reset a 15-minute sign-in window early.
CREATE TABLE staff_sign_in_rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX staff_sign_in_rate_limit_buckets_window_idx
  ON staff_sign_in_rate_limit_buckets(window_started_at);
