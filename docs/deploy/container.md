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
- `GUEST_PUSH_SEAL_SECRET` (optional, at least 32 characters; without it `/api/guest/push-subscription` answers 503 and stores nothing)
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
docker run --rm -e DATABASE_URL -e GUEST_BEARER_SIGNING_SECRET -e VAPID_PUBLIC_KEY -e VAPID_PRIVATE_KEY -e VAPID_SUBJECT -e GUEST_PUSH_SEAL_SECRET tabibi:local npm run worker:notifications
```

Every `NOTIFICATION_DISPATCH_INTERVAL_MS` (default `15000`, range 1000 to 3600000) it dispatches due in-app intents (up to 50 per clinic), then scrubs expired guest-link intents. The guest push channel and its link sender are registered only when `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `GUEST_PUSH_SEAL_SECRET` are all set on the worker (the compose service forwards them); otherwise link intents stay pending until they expire. It is safe to run more than one worker. On SIGTERM it finishes the current tick and exits. Logs carry counts only. In `docker-compose.yml` the service is behind the `worker` profile.

## Image contents

`.dockerignore` excludes `.env*`, tests, docs, coordination files and git metadata. `node_modules` is kept whole because `next.config.ts` needs `typescript` at start-up and the migration command needs `tsx`.

## Staging (synthetic data only)

Owner decision A on #731: staging runs on a managed PaaS with synthetic data only; real patient data waits for the legal and privacy review. The zero-cost setup is a Render free web service built from this `Dockerfile` (region Frankfurt, health check `/api/ready`, auto-deploy from `main`) and a Neon free Postgres 16 project. The free web service sleeps after 15 minutes idle and takes about a minute to wake. The notification worker needs a paid Render worker, so leave it out until push is tested.

Set on the web service: `DATABASE_URL`, `STAFF_SESSION_SECRET`, `GUEST_BEARER_SIGNING_SECRET`, `PUBLIC_AVAILABILITY_SELECTION_SECRET` (each from `openssl rand -base64 48`), `NODE_HEAP_MB=384`, and `PUBLIC_ORIGIN` (the service's https origin, used by `db:issue-patient-reset`).

One-off operations run from the Actions tab with the **Staging operations** workflow (`.github/workflows/staging-ops.yml`), using the `STAGING_DATABASE_URL` repository secret:

1. `migrate`: after the first deploy and after any merge that adds a migration.
2. `create-clinic`: `tenant_key` and `clinic_name`; the run log prints the clinic id.
3. `bootstrap-admin`: `clinic_id`, `admin_email` and `admin_display_name`, with the password in the `STAGING_ADMIN_PASSWORD` secret (delete it afterwards).
