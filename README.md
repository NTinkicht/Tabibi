# Tabibi

Tabibi is an Algeria-first doctor appointment and intelligent queue-management platform. This repository contains the production platform baseline plus the clinic/staff/doctor scheduling and consultation-session persistence foundation. Patient discovery, booking, and queue workflows are intentionally not implemented yet.

## Prerequisites

- Node.js 20 (see `.nvmrc`) and npm 10+
- Docker with Compose v2 for PostgreSQL

## Local setup

```bash
cp .env.example .env.local
npm ci
docker compose up -d --wait postgres
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://localhost:3000>. `GET /api/health` is a process liveness probe and does not depend on PostgreSQL. `GET /api/ready` checks PostgreSQL and returns HTTP 503 when the dependency is unavailable. Both return and propagate a validated `x-request-id` correlation ID.

Configuration is parsed when server infrastructure first needs it. Missing, malformed, or non-PostgreSQL `DATABASE_URL` values produce an explicit startup/request failure rather than an implicit default. `.env.example` contains development-only placeholders; `.env*` files and all real credentials are ignored. Production secrets must be supplied by the deployment environment, never committed.

## Verification

```bash
npm run format
npm run lint
npm run typecheck
npm test
DATABASE_URL=postgresql://tabibi:tabibi_dev_only@localhost:5432/tabibi npm run test:integration
DATABASE_URL=postgresql://tabibi:tabibi_dev_only@localhost:5432/tabibi npm run build
npx playwright install chromium # once per workstation
DATABASE_URL=postgresql://tabibi:tabibi_dev_only@localhost:5432/tabibi npm run test:e2e
```

Integration tests deliberately use a real PostgreSQL server. CI provisions an isolated PostgreSQL 16 service and runs quality, build, integration, and browser smoke jobs from `npm ci`.

The clinic scheduling integration suite migrates a clean database and verifies
tenant authorization, role boundaries, concurrent idempotent occurrence generation,
and the doctor-global open-session invariant with synchronized cross-clinic races.

## Architecture boundaries

Tabibi is a modular monolith. `src/app` is the Next.js delivery layer, `src/platform` contains shared configuration/database/HTTP/observability adapters, and `src/modules` contains explicit business-module boundaries: identity/access, clinic, scheduling, session, queue, estimation, notification-domain, audit, and localization/UI. Modules should expose intentional public contracts and must not reach into another module's internals. PostgreSQL remains the system of record; transaction and locking behavior can use direct SQL.

## Migrations and deterministic data

Committed, immutable SQL files in `db/migrations` are sorted by filename. `npm run db:migrate` takes a PostgreSQL advisory lock, verifies SHA-256 checksums of previously applied migrations, and applies each new file transactionally. Never edit an applied migration; append a new numbered file.

`npm run db:seed` is idempotent, development/test-only, and records the current seed version without patient data. It refuses production. `npm run db:reset:test` is destructive by design but refuses unless `NODE_ENV=test` and the database name clearly ends in `_test`; it is intended only for locally controlled test databases.

## Operational logging

Server logs are structured JSON through Pino. Request completion/failure records include correlation ID, method, status, and duration, but not URLs, bodies, query strings, patient data, or credentials. Common secret and identity fields are redacted. Keep new logs metadata-only in accordance with `SECURITY.md`.

## Project contracts

Start with `PRODUCT.md`, `AGENTS.md`, `ARCHITECTURE.md`, `SECURITY.md`, `coordination/AUTONOMY_PROTOCOL.md`, and `coordination/STATE.json`. GitHub is the durable engineering coordination bus.
