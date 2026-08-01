# Releasing agensis (desktop)

Dev vs package commands, local vs prod backend, ACP hybrid with live web:
**[docs/desktop.md](./docs/desktop.md)**. This file is the ship/sign path only.

The desktop app ships **signed + notarized from a local Mac**, same model as
[infinitty](https://github.com/jasonkneen/infinitty) (`../titerm`). CI can sign
when secrets are present, but the primary path is local.

## TL;DR — cut a desktop release

```sh
VERSION=0.1.2

# 1. bump package.json version, commit, tag
git tag "v$VERSION" && git push origin "v$VERSION"

# 2. build, Developer-ID sign, notarize, staple — one command
npm run desktop:ship

# 3. upload installers to the GitHub release
npm run desktop:ship -- --upload
# or: scripts/ship-signed.sh "$VERSION" --upload
```

`ship-signed.sh` finds the Developer ID cert, runs electron-builder (signed),
notarizes each `.app` + `.dmg` with Apple, staples the tickets, and verifies
with Gatekeeper. After the first run it needs **zero prompts** (notary
credentials are cached in the Keychain as profile `agensis`, or it reuses the
shared `infinitty` profile if you already ship that app).

If the GitHub release for the tag doesn't exist yet, create it first (or let
`--upload` create it):

```sh
gh release create "v$VERSION" --title "agensis v$VERSION" --generate-notes
```

## One-time setup

You need three things, once (shared with infinitty if you already ship that):

1. **A "Developer ID Application" certificate** in your login Keychain.
   Confirm with:
   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
   Expected:
   `Developer ID Application: Jason Kneen (SW75ZJJ5R6)`
   If it's missing, see [Certificate recovery](#certificate-recovery).
   > Note: "Apple Distribution" is a *different* cert (App Store) and
   > **cannot** notarize a directly-distributed app.

2. **Notary credentials** cached in the Keychain. `ship-signed.sh` prompts
   for your Apple ID + an [app-specific password](https://appleid.apple.com)
   the first time and stores them as profile `agensis`. To (re)do it manually:
   ```sh
   xcrun notarytool store-credentials agensis \
     --apple-id "you@example.com" --team-id SW75ZJJ5R6
   ```
   If you already have the `infinitty` profile, ship-signed reuses it.

3. **`gh` authenticated** for uploading release assets (`gh auth status`).

## Certificate recovery

Same cert as infinitty. If `security find-identity` shows no Developer ID
Application but you have signed before:

```sh
security import ~/.infinitty-signing/developerID_application.cer
security find-identity -v -p codesigning | grep "Developer ID Application"
```

Backup of the public cert (and CSR/key for reissue) lives at
`~/.infinitty-signing/`. See infinitty's RELEASING.md for full recovery notes.

## CI (optional)

`.github/workflows/release.yml` builds on `v*` tags / workflow_dispatch. It
signs and notarizes **only when secrets exist**:

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` | base64 of Developer ID `.p12` |
| `CSC_KEY_PASSWORD` | password for that `.p12` |
| `CSC_NAME` | optional; full identity string |
| `APPLE_ID` | notarize |
| `APPLE_APP_SPECIFIC_PASSWORD` | notarize |
| `APPLE_TEAM_ID` | `SW75ZJJ5R6` |

One-time load (export the cert from Keychain Access first — GUI only; CLI
export often packs every identity and exceeds GitHub's secret size limit):

```sh
# Keychain Access → My Certificates → Developer ID Application: Jason Kneen
# → Export → cert.p12 with a password
scripts/setup-signing-secrets.sh ~/Desktop/cert.p12
rm ~/Desktop/cert.p12
```

Without those secrets the mac job still builds **unsigned** artifacts and
skips the signature verify step — do not ship those to users. Prefer
`npm run desktop:ship`.

## Verifying a release is clean

```sh
npm run desktop:verify-sign
# want: Developer ID + codesign --verify OK; spctl accepted

# Simulate a real download (quarantine + Gatekeeper) on a DMG:
xattr -w com.apple.quarantine "0083;0;Safari;" release/agensis-*-mac-arm64.dmg
spctl -a -t open --context context:primary-signature -vv release/agensis-*-mac-arm64.dmg
# want: "accepted  source=Notarized Developer ID"
xcrun stapler validate release/agensis-*-mac-arm64.dmg
# want: "The validate action worked!"
```

## Scripts

| Script / npm | Does |
| --- | --- |
| `npm run desktop:dist` | build installers (sign if keychain cert present) |
| `npm run desktop:verify-sign` | fail closed unless Developer ID signed |
| `npm run desktop:ship` / `scripts/ship-signed.sh` | build + notarize + staple (+ optional `--upload`) |
| `scripts/setup-signing-secrets.sh <p12>` | load CI secrets once |

## Why local first

Same reasons as infinitty: macOS minutes are expensive / sometimes unavailable
on the account, and a Keychain cert + notary profile on a trusted Mac is the
path that already ships clean Gatekeeper builds. The workflow stays ready for
when CI secrets and runners are both available.
