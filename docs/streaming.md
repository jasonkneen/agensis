# Direct desktop broadcasting

Settings → Streaming in Electron sends a selected screen/window to an RTMP service.
Independent broadcasting currently supports macOS and Linux; Windows is disabled
until a per-user secured control transport is implemented. Install FFmpeg with
libx264, AAC and RTMP/RTMPS support (`brew install ffmpeg` on macOS). No cloud setup
or new npm dependency is needed. Capture support on Linux/Wayland depends on the OS.

Copy the current server URL (without key) and stream key from your service dashboard.
Restream, YouTube, Facebook, Twitch, X and custom presets are editable; X requires a
provisioned ingest destination. The previously reported “Media delivery failed” was
confirmed to be incorrect destination details, not an identified transport defect.
Check both fields against the service dashboard before restarting a failed stream.

## Starting, closing and restarting

Choose a source, optionally enable the default microphone, and confirm that it may
broadcast private screen contents publicly. Start Broadcast is always explicit.
Settings closes only after FFmpeg reports encoded output. A persistent global banner
shows sending/starting/error/unknown status, with Stop Broadcast and Streaming
Settings controls. It lives above the authenticated app, so signing out, switching
workspaces or closing Settings does not remove the controller. Sending is not proof
of public live status: check the service dashboard for any final Go Live action.

A separate Electron helper owns BOTH the media source/MediaRecorder and FFmpeg. It
has a separate user profile and process lifecycle, not an IPC child or a detached
encoder depending on the main app's stdin. Quitting/relaunching the main app, renderer
crashes and navigation do not interrupt an ongoing screen broadcast. Reopening the
app queries that helper and reconnects to the existing session; it does not start
another one. Use Stop Broadcast before quitting if you want the broadcast to end.
A connection error is shown as unknown, never as confirmation that media stopped.

Choose a SCREEN to survive restarting agensis. If capturing the agensis WINDOW,
that window disappears when the app quits. Track-ended and source-inventory checks
stop the broadcast explicitly; no new window/screen is selected automatically. The
same rule applies to an unplugged display or another closed application window.
A saved missing source stays marked unavailable until you choose one again.

The helper starts idle after its own exit/crash or a computer restart. It is not a
login service and never resumes a broadcast from saved settings. Stop, source loss,
encoder failure, or helper shutdown cleans capture and terminates FFmpeg. Capture
startup has a 30-second deadline; stalled media has a 15-second deadline. Forced OS
logout/shutdown/sleep, helper termination, screen permission changes, and system
updates are not promises of uninterrupted service. No automatic network reconnect.

Allow Screen Recording and optionally microphone permission for the helper's
Electron application. After changing OS permissions, stop broadcasting and quit the
broadcast helper in Activity Monitor before reopening Streaming; restarting the UI
alone intentionally leaves the helper alive. A signed packaged build's permission
identity and OS-keychain prompts require a manual check on the destination machine.

## Storage and security

The selected source, preset, destination and key are saved on explicit Start using
Electron safeStorage encryption, in `broadcast-helper/broadcast.enc` below the app's
userData directory (0700 directory, 0600 encrypted file). macOS uses Keychain-backed
encryption; Linux needs a supported unlocked secret service. Unavailable encryption
or Linux `basic_text` is refused, not downgraded to plaintext. Keys never return to
the UI: a saved-key boolean lets an empty password field reuse the key only for the
same destination and preset. No localStorage, workspace DB, status or logs hold keys.
FFmpeg stderr is discarded because it can echo credentials. FFmpeg does receive its
full ingest URL as a process argument: privileged/same-user process inspection can
see it. RTMP itself is plaintext; prefer RTMPS.

Control is a bounded JSON request over a Unix socket inside a user-owned 0700
directory, with a 0600 socket. There is no TCP/HTTP endpoint or plaintext bearer
file. The helper profile's single-instance lock is acquired before stale socket
cleanup. Trusted main-frame IPC only; webviews/subframes cannot control it. The
same OS user (including other apps running as that user) is the local trust boundary,
not individual agensis accounts. Configuration cannot supply encoder commands,
input URLs or arbitrary file paths. Capture's sandboxed renderer loads only bundled
local scripts, blocks navigation/new windows, and never receives the destination key.
Media stays off disk. One broadcast per app profile/computer controller, not per tab.

## Implementation and verification

- `electron/broadcast/helper.cjs`: separate profile/lock, capture window, source
  liveness checks, helper-only cleanup; no hosted backend is loaded.
- `capture.{html,js}` / `capture-preload.cjs`: unthrottled sandboxed media owner,
  ordered WebM writes (2 MiB chunk, 4 MiB queue). Background app suspension is
  inhibited only while broadcasting; it does not prevent explicit system sleep.
- `engine.cjs`: existing fixed 1280×720/30fps H.264 4500kbps + AAC 128kbps, GOP 60,
  letterboxing, bounded writes, timeouts and SIGTERM/SIGKILL cleanup. Optional mic;
  otherwise silent audio. No system/huddle audio mixing, cameras or scenes.
- `client.cjs`, `control.cjs`, `ipc.cjs`, `service.cjs`, `store.cjs`: launch/reconnect,
  private control, serialized start, encrypted settings. The main app has no capture
  or encoder quit hook. Source stream repository remains untouched.
- `src/lib/broadcast.ts`, `BroadcastIndicator.tsx`, `StreamingPanel.tsx`: shared status
  polling without media ownership, persistent banner and settings controller.

Focused checks:

```sh
node --require ./tests/helpers/test-env.cjs --test tests/broadcast*.test.cjs
AGENSIS_ELECTRON_BROADCAST_TEST=1 node --require ./tests/helpers/test-env.cjs --test tests/broadcast-helper-loopback.test.cjs
npm run test:unit -- tests/unit/broadcast.test.ts tests/unit/huddleSingleCall.test.ts
npm run smoke -- tests/smoke/streaming.smoke.ts
```

The opt-in Electron integration needs a GUI session. It launches foreground owned
test fixtures: production helper/MediaRecorder/IPC/FFmpeg with synthetic canvas pixels
and a loopback-only RTMP receiver. Controller processes exit, media continues, fresh
controllers reconnect/stop, and a helper restart remains idle with encrypted config.
Its encryption adapter is synthetic to avoid OS credential prompts; unit tests cover
fail-closed storage. Real OS capture, keychain access, packaged app restart and
provider-account acceptance remain manual checks. Tests never broadcast externally.
