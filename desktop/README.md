# agensis desktop shell (Native SDK experiment)

Zig/Native SDK window around the Vite/React app.

**Day-to-day Electron local dev** (setup A fully local, setup B desktop + live
web, ACP Start/Stop, switching backends):

→ **[docs/desktop.md](../docs/desktop.md)**

This folder is the Native SDK layout, not the Electron tree under `electron/`.

On macOS 26 (Tahoe), the main window uses `titlebar = "hidden_inset_tall"` so the
system applies the larger unified-toolbar corner radius (plain `hidden_inset`
keeps the older, tighter corners).

## Layout

| Path | Role |
| --- | --- |
| `app.zon` | App identity, window chrome, frontend dev URL, security |
| `src/main.zig` | WebView source + dialog/openUrl bridge policy |
| `src/runner.zig` | Platform host bootstrap (from Native SDK vite scaffold) |
| `../dist` | Production UI assets (root `npm run build`) |
| `../../native` | Sibling checkout of [vercel-labs/zero-native](https://github.com/vercel-labs/zero-native) (next to `agensis/`) |

## Prerequisites

- Zig `0.16+` on `PATH`
- `native` CLI (`npm i -g @native-sdk/cli`) for `zig build dev` / `package`
- SDK sources at `../../native` relative to this folder (or pass `-Dnative-sdk-path=...`)

## Electron scripts (repo root)

Full table and hybrid “live web + local Mac ACP” workflow:

→ **[docs/desktop.md](../docs/desktop.md)**

| Goal | Dev | Package |
| --- | --- | --- |
| Desktop ↔ **local** (`:3142`) | `npm run desktop:dev:local` | `npm run desktop:build:local` |
| Desktop ↔ **prod** (Fly / live web) | `npm run desktop:dev:prod` | `npm run desktop:build:prod` |

After switching local ↔ prod, **re-Start** ACP agents. Confirm main log
`ws=wss://agensis-backend.fly.dev/...` (prod) or `ws=ws://127.0.0.1:3142/...` (local).

Native SDK-only loop (once backend/Vite already match your target):

```bash
zig build dev
```

## Bridge (Native SDK; replaces Electron IPC when that shell is used)

| Need | API |
| --- | --- |
| Folder picker | `window.zero.invoke('native-sdk.dialog.openFile', { allowDirectories: true })` |
| Desktop detect | `Boolean(window.zero)` |
| External links | `security.navigation.external_links = open_system_browser` |
