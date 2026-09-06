-- Platform-only baseline. Domain tables arrive in bounded vertical-slice PRs.
CREATE TABLE IF NOT EXISTS platform_metadata (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
