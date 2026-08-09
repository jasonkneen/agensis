# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

# The native LiveKit core uses the system trust store when connecting to Cloud.
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app

# Keep the install reproducible and cacheable with the lockfile already used by
# local development and CI. This worker is plain ESM and has no compile step.
COPY package.json package-lock.json ./
# onnxruntime-node bundles its CPU runtime, while its default Linux installer
# also reaches NuGet for optional CUDA binaries. Cloud agents do not expose a
# GPU here, so skip that large, failure-prone download explicitly.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci --omit=dev --no-audit --no-fund

# Download Silero assets at image-build time so the first huddle does not pay
# for a model download and the production container needs no writable cache.
RUN npx livekit-agents download-files

COPY src ./src

FROM base
ARG UID=10001
RUN adduser \
  --disabled-password \
  --gecos "" \
  --home "/app" \
  --shell "/sbin/nologin" \
  --uid "${UID}" \
  appuser

WORKDIR /app
COPY --from=build --chown=appuser:appuser /app /app
USER appuser
ENV NODE_ENV=production

CMD ["npm", "start"]
