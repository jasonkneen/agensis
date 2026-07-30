# Self-hosting image: builds the frontend and runs the backend in ONE container,
# so the app, the API and the realtime websocket all share a single origin.
#
# This is NOT the production image. Fly deploys from Dockerfile.fly, which is
# backend-only because Netlify serves the frontend there. The two are separate
# on purpose; changing one does not change the other.
#
#   docker compose up        # what a self-hoster runs (see README, "Run with Docker")
#   docker build -t agensis . # this file on its own

# ---------------------------------------------------------------------------
# Stage 1: build the frontend bundle (needs devDependencies: vite, tsc, tailwind)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# electron is a devDependency of the desktop shell and its postinstall pulls a
# ~100MB binary this image will never run.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# `npm install` rather than `npm ci`, matching Dockerfile.fly: it tolerates
# lockfile drift in the app repository.
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# Only set this when serving over HTTPS on a hostname that is not localhost —
# see the note in .env.docker.example. Left empty, the frontend talks to
# whatever origin it was loaded from, which is what a single container wants.
ARG VITE_BACKEND_BASE_URL=""
ENV VITE_BACKEND_BASE_URL=$VITE_BACKEND_BASE_URL

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime — production dependencies, the backend, the built bundle
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# psql applies database/neon-schema.sql on boot (docker-entrypoint.sh) — the
# same bootstrap `npm run db:neon:push` performs.
RUN apk add --no-cache postgresql16-client

COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Backend source + the SQL the runtime schema / migrations reference. Same set
# as Dockerfile.fly, plus the entrypoint and the frontend bundle.
COPY server ./server
COPY shared ./shared
COPY database ./database
COPY supabase/migrations ./supabase/migrations
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY --from=build /app/dist ./dist

# AGENSIS_STATIC_ROOT is what makes the backend serve ./dist at all; unset (as
# on Fly) it serves only /backend/*. See server/static-site.cjs.
ENV AGENSIS_STATIC_ROOT=/app/dist \
    AGENSIS_UPLOAD_ROOT=/data/uploads \
    HOST=0.0.0.0 \
    API_PORT=3142

# `node` (uid 1000) ships with the base image. /data is the upload root and is
# where the compose volume mounts, so it has to be writable by that user.
RUN chmod +x docker-entrypoint.sh \
 && mkdir -p /data/uploads \
 && chown -R node:node /data

USER node
EXPOSE 3142
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server/index.cjs"]
