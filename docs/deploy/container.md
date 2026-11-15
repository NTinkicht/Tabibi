# Container image

`Dockerfile` builds the Tabibi web application as a multi-stage image on `node:20-bookworm-slim` (the version in `.nvmrc`). The final stage runs as the non-root `node` user. No host is chosen here and nothing is deployed.

```
docker build -t tabibi:local .
docker run --rm -p 3000:3000 --env-file <your-env-file> tabibi:local
```

## Health

- Liveness: `GET /api/health`.
- Readiness: `GET /api/ready` (checks the database). The image `HEALTHCHECK` uses readiness.

## Memory

`NODE_HEAP_MB` (default `384`) bounds the Node old-space heap in megabytes. Lower or raise it for the host's memory limit.

## Runtime variables (names only, set at run time, never in the image)

- `DATABASE_URL`
- `STAFF_SESSION_SECRET`
- `STAFF_SESSION_TTL_SECONDS` (optional)
- `GUEST_BEARER_SIGNING_SECRET`
- `PUBLIC_AVAILABILITY_SELECTION_SECRET`
- `PORT` (default `3000`), `NODE_HEAP_MB` (default `384`)

## Migrations

Migrations are not run on container start. Run them as a separate one-off step against the target database, using the same image:

```
docker run --rm -e DATABASE_URL tabibi:local npm run db:migrate
```

Migration files under `db/migrations` are immutable; add a new numbered file for any change.

## Notification worker

Notifications are sent automatically only while a worker runs. Run it from the same image as a second process, next to the web container:

```
docker run --rm -e DATABASE_URL -e GUEST_BEARER_SIGNING_SECRET tabibi:local npm run worker:notifications
```

Every `NOTIFICATION_DISPATCH_INTERVAL_MS` (default `15000`, range 1000 to 3600000) it dispatches due in-app intents (up to 50 per clinic), then scrubs expired guest-link intents. No guest-link sender is registered yet, so link intents stay pending until they expire. It is safe to run more than one worker. On SIGTERM it finishes the current tick and exits. Logs carry counts only. In `docker-compose.yml` the service is behind the `worker` profile.

## Image contents

`.dockerignore` excludes `.env*`, tests, docs, coordination files and git metadata. `node_modules` is kept whole because `next.config.ts` needs `typescript` at start-up and the migration command needs `tsx`.
