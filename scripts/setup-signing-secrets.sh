#!/bin/zsh
# One-time: store CI signing secrets for the release workflow.
# Same workflow as infinitty (../titerm/scripts/setup-signing-secrets.sh),
# but secret names match electron-builder (CSC_*) + Apple notarize env.
#
# Export the cert FIRST via Keychain Access (GUI) — exporting from the CLI
# grabs every identity in the keychain and blows GitHub's 48KB secret limit:
#   Keychain Access -> My Certificates -> "Developer ID Application: Jason
#   Kneen" -> right-click -> Export -> .p12 with a password.
#
# Then: scripts/setup-signing-secrets.sh ~/Desktop/cert.p12
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${GITHUB_REPOSITORY:-jasonkneen/agensis}"
P12="${1:?usage: setup-signing-secrets.sh <path-to-cert.p12>}"
SIZE=$(stat -f %z "$P12")
if [ "$SIZE" -gt 20000 ]; then
  echo "That p12 is ${SIZE} bytes — it likely contains multiple identities."
  echo "Export ONLY the Developer ID Application cert from Keychain Access."
  exit 1
fi

read -s "P12PASS?Password you set when exporting the .p12: "; echo
# electron-builder expects CSC_LINK as a path OR base64 of the p12
gh secret set CSC_LINK --repo "$REPO" --body "$(base64 -i "$P12")"
gh secret set CSC_KEY_PASSWORD --repo "$REPO" --body "$P12PASS"
# Optional explicit identity (same string as package.json mac.identity / keychain)
gh secret set CSC_NAME --repo "$REPO" --body "Developer ID Application: Jason Kneen (SW75ZJJ5R6)"

read "APPLEID?Apple ID email: "
gh secret set APPLE_ID --repo "$REPO" --body "$APPLEID"
echo "App-specific password: appleid.apple.com -> Sign-In & Security -> App-Specific Passwords"
read -s "APPPASS?App-specific password: "; echo
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo "$REPO" --body "$APPPASS"
gh secret set APPLE_TEAM_ID --repo "$REPO" --body "SW75ZJJ5R6"

echo ""
echo "Signing secrets set on $REPO:"
echo "  CSC_LINK, CSC_KEY_PASSWORD, CSC_NAME"
echo "  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID"
echo ""
echo "Primary path is still local (like infinitty):"
echo "  npm run desktop:ship"
echo "  npm run desktop:ship -- --upload   # after tagging vX.Y.Z"
echo ""
echo "CI (.github/workflows/release.yml) will sign/notarize when these secrets"
echo "exist. Until then, cut releases with desktop:ship."
echo "Finally: rm '$P12'"
