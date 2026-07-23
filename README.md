# agensis

A realtime collaborative workspace for chat, documents, memory, files, and a shared canvas.

<img width="1625" height="1069" alt="image" src="https://github.com/user-attachments/assets/b57b9aca-ef3f-4c88-84fb-a58be227912e" />


## What it is

agensis is a multiplayer workspace app built with React, TypeScript, Vite, Neon Postgres, and a local Node Backend server. A **workspace** is the top-level shared room. Inside a workspace, users can:

- chat with AI
- create and edit documents
- store memory/facts
- upload files
- draw and manipulate objects on a shared canvas
- see other users live with cursors and presence

## Core ideas

- **Workspace-first model** — collaboration happens at the workspace level
- **Shared canvas** — drawings and object movement sync in realtime
- **Local windows, shared content** — each user can open their own windows without forcing them open for everyone else
- **Realtime presence** — live cursor updates and workspace presence indicators

## Features

- realtime multiplayer cursors
- realtime canvas object updates
- shared workspace canvas
- floating document / chat / memory windows
- document autosave
- image and file drop support
- sticky notes, shapes, lines, arrows, and pen strokes
- workspace sharing with members and roles
- workspace grid view with previews
- wallpaper-backed home and workspace views

## Tech stack

- React 19
- TypeScript
- Vite
- Neon Postgres
- Node / Express / WebSocket backend
- Lucide React
- Vite PWA plugin

## Local development

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file with your Neon database connection and AI key:

```bash
DATABASE_URL=postgresql://user:password@host/db?sslmode=require
NEON_API_KEY=your_neon_admin_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### 3. Bootstrap the Neon database

The schema lives at:

```text
database/neon-schema.sql
```

Apply it with:

```bash
npm run db:neon:push
```

### 4. Run the local backend server

```bash
npm run backend
```

This serves the Neon-backed database API, local auth, realtime websocket bridge, and AI chat route.

### 5. Run the app

```bash
npm run dev
```

### 6. Run the desktop app in development (Native SDK)

```bash
npm run desktop:dev
```

This ensures the local backend is up, then builds the Native SDK shell and starts Vite + the native WebView window. Requires Zig 0.16+, the `native` CLI (`npm i -g @native-sdk/cli`), and a sibling checkout of the SDK at `../native` (i.e. next to this repo).

### 7. Production build

```bash
npm run build
```

### 8. Package desktop app

```bash
npm run desktop:dist
```

Packaged desktop artifacts are written to:

```text
desktop/zig-out/package/
```

### 9. Typecheck

```bash
npm run typecheck
```

### 10. Lint

```bash
npm run lint
```

## Backend

This repository now runs on a Neon-backed local backend server.

At minimum, a fresh setup should:

- provision a Neon Postgres database
- set `DATABASE_URL`
- run `npm run db:neon:push`
- set `ANTHROPIC_API_KEY` if using AI chat
- run `npm run backend`

## Production daemon sockets

Netlify Functions serve the deployed HTTP API routes, but they do not host
long-lived WebSocket upgrade servers. Agent daemon commands therefore need a
separate long-running Node backend that runs `server/index.cjs` and serves
`/backend/ws`.

For production, deploy `server/index.cjs` to a Node host that supports
WebSockets, point it at the same database, and set this environment variable on
the Netlify site:

```bash
AGENSIS_DAEMON_BASE_URL=https://your-daemon-backend.example.com
```

After that is configured, the AI Agents window generates `agensis connect`
commands against the daemon backend. Without this value, command generation
returns a clear configuration error instead of producing a command that points
at the Netlify site and fails with a websocket 404.

## Project structure

```text
src/
  components/   UI components
  hooks/        app state and realtime hooks
  lib/          backend client and offline helpers
  types/        shared types
server/
  index.cjs     Neon-backed API + realtime websocket server
database/
  neon-schema.sql
```

## Current product shape

agensis currently focuses on:

- collaborative workspaces
- shared visual thinking on canvas
- AI chat inside the same environment
- document + memory workflows alongside the canvas

## Notes

- the open-source daemon lives in the sibling
  [`agensis-agent`](https://github.com/jasonkneen/agensis-agent) repository
- realtime behavior depends on the local backend server websocket bridge
- workspace sharing and presence depend on authenticated users and workspace membership

## License

MIT
