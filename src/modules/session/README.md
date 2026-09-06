# session

This directory owns consultation-session reads and foundation lifecycle transitions:
`planned`, `open`, `paused`, `closed`, and `cancelled`. Open/resume transitions take
a doctor-keyed PostgreSQL transaction advisory lock, while a partial unique index is
the final guarantee that a doctor has at most one open session across all clinics.
Queue-dependent close/cancel behavior is intentionally deferred.
