#!/usr/bin/env bash
# ComfyUI Desktop 2.0 -- macOS reset script
#
# Wipes app settings, caches, and the Chromium profile for the current build
# AND for the older beta names (ComfyUI Launcher / com.kosinkadink.* /
# org.comfy.comfyui-launcher), in case leftovers from a previous version are
# breaking the UI (no styles, no i18n, dropdowns not working, etc.) after a
# manual update.
#
# Does NOT touch your actual ComfyUI installs at ~/ComfyUI-Installs. The
# script DOES remove installations.json (the registry), so you may need to
# re-add existing installs via "Add existing installation" on first launch.
#
# Usage:
#   bash reset-mac.sh           # asks for confirmation
#   bash reset-mac.sh --yes     # skip confirmation

set -u

YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    -h|--help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

# Refuse to run while the app is open (includes the upcoming post-rename
# "Comfy Desktop" process name)
if pgrep -x "Comfy Desktop"     >/dev/null 2>&1 \
   || pgrep -x "ComfyUI Desktop 2.0" >/dev/null 2>&1 \
   || pgrep -x "ComfyUI Launcher"  >/dev/null 2>&1; then
  echo "Comfy Desktop / Launcher is running. Please quit it first (Cmd+Q),"
  echo "then re-run this script."
  exit 1
fi

# Product (display) names that map to ~/Library/Application Support and Logs
# folders. Includes the upcoming post-rename name ("Comfy Desktop") so
# scripts shipped today still work after the 2.0 suffix drops, and the
# legacy v1.x desktop productName ("ComfyUI") whose userData/logs survive
# an upgrade to the 2.0 beta and have caused clean-install issues (#679).
PRODUCT_NAMES=(
  "ComfyUI"
  "Comfy Desktop"
  "ComfyUI Desktop 2.0"
  "ComfyUI Launcher"
)

# Package.json "name" values. Electron uses this for userData in dev/source
# runs, and electron-updater uses it (+ "-updater") for the auto-update
# cache that holds pending update.zip blobs — leaving this around lets a
# fresh install get clobbered by a stale cached update on next launch.
PACKAGE_NAMES=(
  "comfyui-desktop-2"
  "comfyui-launcher"
)

BUNDLE_IDS=(
  "org.comfy.comfyui-desktop-2"
  "org.comfy.comfyui-launcher"
  "com.kosinkadink.comfyui-launcher"
)

TARGETS=()

for name in "${PRODUCT_NAMES[@]}"; do
  TARGETS+=(
    "$HOME/Library/Application Support/$name"
    "$HOME/Library/Logs/$name"
  )
done

for name in "${PACKAGE_NAMES[@]}"; do
  TARGETS+=(
    # Dev / source-run userData (Electron falls back to package.json "name"
    # when productName isn't honored).
    "$HOME/Library/Application Support/$name"
    # electron-updater pending-update cache (holds update.zip + pending/).
    # If left in place, the updater can re-apply a stale update over the
    # freshly-installed .app on next launch.
    "$HOME/Library/Caches/${name}-updater"
  )
done

shopt -s nullglob

for id in "${BUNDLE_IDS[@]}"; do
  TARGETS+=(
    "$HOME/Library/Preferences/${id}.plist"
    "$HOME/Library/Caches/${id}"
    # Squirrel.Mac ShipIt cache — handles in-place app replacement during
    # auto-update; stale state here can re-trigger an old swap.
    "$HOME/Library/Caches/${id}.ShipIt"
    "$HOME/Library/Saved Application State/${id}.savedState"
    "$HOME/Library/WebKit/${id}"
  )
  # HTTPStorages has both bare and ".binarycookies" variants
  for p in "$HOME/Library/HTTPStorages/${id}" \
           "$HOME/Library/HTTPStorages/${id}.binarycookies"; do
    TARGETS+=("$p")
  done
  # Native macOS cookies jar (separate from Chromium's Cookies file
  # inside userData). NSURLSession-style native calls write here if the
  # app ever makes them.
  TARGETS+=("$HOME/Library/Cookies/${id}.binarycookies")
  # Per-host Preferences (Squirrel.Mac writes ShipIt state under
  # ~/Library/Preferences/ByHost/<id>.ShipIt.<HOST-UUID>.plist; the
  # host-UUID suffix varies per machine so we glob).
  for p in "$HOME/Library/Preferences/ByHost/${id}".*.plist; do
    TARGETS+=("$p")
  done
done

shopt -u nullglob

# Warn (don't auto-delete) about extra .app copies — multiple installs in
# different locations are a common cause of "I reinstalled but it's still
# broken" because the user keeps launching an older copy.
APP_LOCATIONS=()
for app_name in "${PRODUCT_NAMES[@]}"; do
  while IFS= read -r line; do
    [ -n "$line" ] && APP_LOCATIONS+=("$line")
  done < <(mdfind "kMDItemFSName == '${app_name}.app'" 2>/dev/null)
done

EXISTING=()
for t in "${TARGETS[@]}"; do
  if [ -e "$t" ]; then
    EXISTING+=("$t")
  fi
done

if [ ${#EXISTING[@]} -eq 0 ]; then
  echo "Nothing to remove. No ComfyUI Desktop 2.0 / Launcher data found."
  exit 0
fi

echo "The following will be permanently deleted:"
echo
for t in "${EXISTING[@]}"; do
  echo "  $t"
done
echo
echo "Your ComfyUI installs at ~/ComfyUI-Installs will NOT be touched."
echo "(You may need to re-add them via 'Add existing installation' on first launch.)"
echo

# Surface any .app copies the user has on disk. We don't delete them — the
# user may legitimately keep multiple builds around — but flag them so they
# can verify they're launching the right one. Multiple .apps in different
# locations is the most common reason a "reset" appears not to work: the
# user's Dock keeps launching an older cached copy.
if [ ${#APP_LOCATIONS[@]} -gt 0 ]; then
  echo "Found these app copies on disk (NOT deleted — verify you launch the right one):"
  for app in "${APP_LOCATIONS[@]}"; do
    echo "  $app"
  done
  echo
fi

if [ "$YES" -ne 1 ]; then
  printf "Proceed? [y/N] "
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

for t in "${EXISTING[@]}"; do
  echo "Removing: $t"
  rm -rf -- "$t"
done

echo
echo "Done. Reinstall ComfyUI Desktop 2.0 from the latest .dmg if you haven't already,"
echo "then launch it. The app should come up with a clean profile."
