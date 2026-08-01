#!/bin/zsh
# Fully sign + notarize + staple the desktop app, locally — same model as
# ../titerm (infinitty): keychain Developer ID + notarytool profile, not CI.
#
# Prereq: "Developer ID Application" cert in login Keychain
#         (same cert as infinitty; team SW75ZJJ5R6).
# Usage:
#   scripts/ship-signed.sh                 # version from package.json
#   scripts/ship-signed.sh 0.1.2           # explicit version
#   scripts/ship-signed.sh 0.1.2 --upload  # also gh release upload
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
UPLOAD=0
if [ "${1:-}" = "--upload" ]; then
  VERSION=""
  UPLOAD=1
elif [ "${2:-}" = "--upload" ]; then
  UPLOAD=1
fi
if [ -z "$VERSION" ]; then
  VERSION=$(node -p "require('./package.json').version")
fi
[[ "$VERSION" =~ '^[0-9]+\.[0-9]+\.[0-9]+' ]] || {
  echo "ERROR: '$VERSION' is not a semver X.Y.Z"
  exit 1
}
TAG="v$VERSION"

IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)"/\1/')
if [ -z "$IDENTITY" ]; then
  echo "ERROR: no 'Developer ID Application' cert in Keychain."
  echo "Create one: Xcode > Settings > Accounts > (your team) > Manage Certificates > + > Developer ID Application"
  echo "Or re-import: security import ~/.infinitty-signing/developerID_application.cer"
  exit 1
fi
echo "Signing identity: $IDENTITY"

# Prefer an agensis notary profile; fall back to the shared infinitty one
# (same Apple team SW75ZJJ5R6). Prompt once if neither exists.
NOTARY_PROFILE=""
for p in agensis infinitty; do
  if xcrun notarytool history --keychain-profile "$p" >/dev/null 2>&1; then
    NOTARY_PROFILE="$p"
    break
  fi
done
if [ -z "$NOTARY_PROFILE" ]; then
  echo "Set up notarization credentials (one time, stored in Keychain as profile 'agensis'):"
  read "APPLEID?  Apple ID email: "
  echo "  App-specific password: appleid.apple.com > Sign-In & Security > App-Specific Passwords"
  read -s "APPPASS?  App-specific password: "; echo
  xcrun notarytool store-credentials agensis \
    --apple-id "$APPLEID" --team-id SW75ZJJ5R6 --password "$APPPASS"
  NOTARY_PROFILE=agensis
fi
echo "Notary profile: $NOTARY_PROFILE"

echo "Building signed desktop installers (electron-builder)…"
# Keychain identity; do not force CSC_IDENTITY_AUTO_DISCOVERY=false.
# electron-builder notarize skips without APPLE_* — we notarize below.
export CSC_IDENTITY_AUTO_DISCOVERY=true
unset CSC_LINK CSC_KEY_PASSWORD 2>/dev/null || true
# Verify signature after build, but don't require notarized yet.
export SKIP_DESKTOP_SIGN_VERIFY=0
export REQUIRE_NOTARIZED=0
node scripts/desktop-build.mjs --publish never

# Collect artifacts for this version
apps=()
for dir in release/mac-arm64 release/mac release/mac-universal; do
  if [ -d "$dir" ]; then
    for app in "$dir"/*.app(N); do
      apps+=("$app")
    done
  fi
done
dmgs=(release/agensis-${VERSION}-mac-*.dmg(N))
zips=(release/agensis-${VERSION}-mac-*.zip(N))

if (( ${#apps[@]} == 0 )); then
  echo "ERROR: no .app under release/mac* after build"
  exit 1
fi
if (( ${#dmgs[@]} == 0 )); then
  echo "ERROR: no release/agensis-${VERSION}-mac-*.dmg after build"
  exit 1
fi

echo "Notarizing app bundles…"
for app in "${apps[@]}"; do
  parent=$(basename "$(dirname "$app")")
  zipname="release/.notarize-$(basename "$app" .app)-${parent}.zip"
  rm -f "$zipname"
  ditto -c -k --keepParent "$app" "$zipname"
  xcrun notarytool submit "$zipname" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  rm -f "$zipname"

  # Rebuild the update zip from the stapled app (arch from parent dir name)
  arch=""
  case "$parent" in
    mac-arm64) arch=arm64 ;;
    mac) arch=x64 ;;
    mac-universal) arch=universal ;;
  esac
  if [ -n "$arch" ]; then
    outzip="release/agensis-${VERSION}-mac-${arch}.zip"
    rm -f "$outzip"
    ditto -c -k --keepParent "$app" "$outzip"
    echo "  rebuilt $outzip from stapled app"
  fi
done

# electron-builder leaves the outer DMG unsigned. Gatekeeper needs the
# container signed before notarize (same as infinitty make-dmg.sh).
echo "Signing + notarizing DMGs…"
for dmg in "${dmgs[@]}"; do
  codesign --force --timestamp --sign "$IDENTITY" "$dmg"
  codesign -vvv --strict "$dmg" 2>&1 | tail -3
  xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
done

echo "Verifying (signed + notarized)…"
REQUIRE_NOTARIZED=1 node scripts/desktop-verify-sign.mjs
for dmg in "${dmgs[@]}"; do
  # Match infinitty RELEASING.md: simulate download Gatekeeper check
  spctl -a -t open --context context:primary-signature -vv "$dmg" 2>&1 | head -6
  if ! spctl -a -t open --context context:primary-signature "$dmg" >/dev/null 2>&1; then
    echo "ERROR: Gatekeeper rejected $dmg"
    exit 1
  fi
done

if [ "$UPLOAD" = "1" ]; then
  gh auth status >/dev/null 2>&1 || {
    echo "ERROR: gh not authenticated (run: gh auth login)"
    exit 1
  }
  if ! gh release view "$TAG" >/dev/null 2>&1; then
    echo "Creating release $TAG…"
    gh release create "$TAG" --title "agensis $TAG" --generate-notes
  fi
  assets=("${dmgs[@]}" "${zips[@]}")
  # sha256 sidecars
  for f in "${dmgs[@]}" "${zips[@]}"; do
    shasum -a 256 "$f" > "${f}.sha256"
    assets+=("${f}.sha256")
  done
  echo "Uploading to release $TAG…"
  gh release upload "$TAG" "${assets[@]}" --clobber
  echo "Uploaded: ${assets[*]}"
fi

echo ""
echo "DONE — signed, notarized, stapled (v$VERSION)."
echo "  apps: ${apps[*]}"
echo "  dmgs: ${dmgs[*]}"
if [ "$UPLOAD" = "1" ]; then
  echo "  release: $TAG"
else
  echo "  To upload: scripts/ship-signed.sh $VERSION --upload"
fi
echo "  No Gatekeeper errors expected for distributed DMGs."
