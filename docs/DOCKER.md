# Run with Docker

Self-hosting, with no Neon account and nothing to deploy. One container serves
the app, the API and the realtime websocket; a second runs Postgres.

Requires Docker with Compose v2 (`docker compose version`).

```bash
cp .env.docker.example .env
docker compose up
```

The first build compiles the frontend and takes a few minutes. When it is up,
the app is at:

```text
http://localhost:3142
```

Create an account on that page — the first sign-up is a normal one, there is no
seeded user. The database schema is applied on boot, so there is no separate
migration step.

Every value in `.env.docker.example` has a working default. Two are worth
reading before you expose this to anyone else: `POSTGRES_PASSWORD`, and
`AGENSIS_AUTH_SECRET` (left empty, the server generates one on first boot and
keeps it in the database). `ANTHROPIC_API_KEY` enables AI chat and can also be
set later in the running app under Settings → Secret keys.

To stop:

```bash
docker compose down
```

Uploads and the database survive that. To throw both away and start from an
empty database:

```bash
docker compose down -v
```

---

Everything below is reference. The section above is the whole of what a
first-time self-hoster needs.

## Environment

`.env.docker.example` is the full list. Nothing in it is required.

| Variable | Default | |
|---|---|---|
| `APP_PORT` | `3142` | Port the app is published on. |
| `POSTGRES_PASSWORD` | `agensis` | The bundled database. Port 5432 is deliberately not published, so it is reachable only on the compose network. `openssl rand -hex 16` if the host is shared. |
| `AGENSIS_AUTH_SECRET` | *(empty)* | Signs session tokens. Empty is correct for one instance — the server mints a secret on first boot and stores it in `app_settings`. Set it (`openssl rand -hex 32`) to run more than one app container against one database. Changing it signs everyone out. |
| `ANTHROPIC_API_KEY` | *(empty)* | Enables AI chat. Also settable in-app. |
| `AGENSIS_APP_URL` | *(empty)* | Public origin for invite and join links. Defaults to the request's own host. |
| `VITE_BACKEND_BASE_URL` | *(empty)* | Only needed for HTTPS on a non-localhost hostname — see below. Baked into the bundle, so `docker compose build` after changing it. |

## Serving over HTTPS on your own hostname

Set `VITE_BACKEND_BASE_URL` to the same public origin you serve on:

```bash
VITE_BACKEND_BASE_URL=https://agensis.example.com
docker compose build && docker compose up -d
```

Without it the app loads and the API works, but realtime does not connect —
`realtimeDisabledOnThisHost()` in `src/lib/backendClient.ts` refuses to open a
websocket on an HTTPS non-loopback origin unless a backend URL was configured.
Localhost over HTTP is unaffected, which is why the default is empty.

## What happens on boot

`docker-entrypoint.sh` waits for Postgres, then applies the schema in a
specific order before starting the server:

1. **`database/neon-schema.sql`** via `psql` — the plain-Postgres bootstrap,
   what `npm run db:neon:push` applies. It is the only one of the three schema
   sources that creates the core tables (`app_users`, `workspaces`,
   `chat_sessions`, `messages`, `tasks`, …). Idempotent, so it runs every boot
   and a database left half-built by an interrupted first run repairs itself.
2. **`scripts/migrate.mjs`** — the incremental migrations. This has to come
   *second*: several files in `supabase/migrations/` are Supabase-flavoured
   (`auth.uid()`, RLS policies against `auth.users`) and would fail on stock
   Postgres. Run after step 1, the runner sees a complete core schema, backfills
   those files from its frozen baseline manifest without executing them, and
   applies only what is genuinely new.
3. **`ensureRuntimeSchema()`** in `server/index.cjs`, once the server starts. It
   only ever ADDs to an existing schema, so it cannot stand in for step 1.

Reversing 1 and 2 is the difference between a database that builds and one that
dies on the third migration. That ordering is the reason there is an entrypoint
script rather than a bare `CMD`.

On a genuinely fresh database the first boot logs one benign warning —
`startup agent-connection reconcile skipped: relation "agent_jobs" does not
exist` — because the startup reconcile does not wait for `ensureRuntimeSchema()`
to create that table. It is caught, it appears only once, and it predates the
container.

## How the frontend is served

The container adds a static-file route to the Node server; there is no nginx.

Production does **not** work this way: Netlify serves the built site and the Fly
backend serves only `/backend/*`, on a different origin. But the frontend is
already written for the single-origin case — `BACKEND_BASE` in
`src/lib/backendClient.ts` resolves to `''` on any host that is not `agensis.io`
or `*.netlify.app`, so `/backend/...` fetches are already same-origin-relative
and the websocket URL is already built from `window.location.host`. It needed
something to serve it, not a different client.

`server/static-site.cjs` is that route. It is mounted **last** in `createApp()`,
after every `/backend` route, so neither it nor its SPA fallback can shadow an
API route, and the fallback refuses `/backend` outright — a route that does not
exist returns the API's own 404, never `200` and an HTML page.

It is off unless `AGENSIS_STATIC_ROOT` is set. `fly.toml` does not set it, so
the Fly deployment is byte-for-byte unaffected. `Dockerfile.fly` is untouched
and still builds the backend-only production image.

An nginx service would have meant a second process and a second config to
achieve what one `express.static` call does, and it would have had to reproduce
the `/backend` and websocket routing rules rather than inherit them.

## The two images

| | `Dockerfile.fly` | `Dockerfile` |
|---|---|---|
| Used by | Fly production deploys | `docker compose`, self-hosting |
| Contains | backend only | backend + built frontend |
| Serves | `/backend/*` and the websocket | those, plus the app |

They are separate on purpose. Changing one does not change the other.

## Data

Two named volumes. `docker compose down` keeps both; `down -v` destroys both.

| Volume | Holds |
|---|---|
| `db-data` | Postgres |
| `uploads` | uploaded files, mounted at `/data` (`AGENSIS_UPLOAD_ROOT=/data/uploads`) |
