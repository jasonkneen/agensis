# agensis desktop shell (Native SDK)

Thin native window around the same Vite/React app the web build uses. Replaces the previous Electron shell.

## Layout

| Path | Role |
| --- | --- |
| `app.zon` | App identity, window chrome, frontend dev URL, security |
| `src/main.zig` | WebView source + dialog/openUrl bridge policy |
| `src/runner.zig` | Platform host bootstrap (from Native SDK vite scaffold) |
| `../dist` | Production UI assets (root `npm run build`) |
| `../native` | Sibling checkout of [vercel-labs/zero-native](https://github.com/vercel-labs/zero-native) |

## Prerequisites

- Zig `0.16+` on `PATH`
- `native` CLI (`npm i -g @native-sdk/cli`) for `zig build dev` / `package`
- SDK sources at `../native` (or pass `-Dnative-sdk-path=...`)

## Dev

From the repo root (starts backend if needed, then Vite + native shell):

```bash
npm run desktop:dev
```

Or from this directory once the backend is already up:

```bash
zig build dev
```

## Package

```bash
npm run desktop:build
# or: npm run desktop:dist
```

Artifacts land in `desktop/zig-out/package/`.

## Bridge (replaces Electron IPC)

| Need | API |
| --- | --- |
| Folder picker | `window.zero.invoke('native-sdk.dialog.openFile', { allowDirectories: true })` |
| Desktop detect | `Boolean(window.zero)` |
| External links | `security.navigation.external_links = open_system_browser` |

The React app still talks to the hosted backend via `VITE_BACKEND_BASE_URL` baked at package time — same thin-shell model as before.
