#!/usr/bin/env bash
#
# Swap the active installations.json with a named profile for testing.
#
# Saves/restores installations.json profiles in a "test-profiles" folder
# next to the live data file. Useful for testing different installation
# configurations (e.g. single install, multiple installs, desktop-only).
#
# The app should be closed before swapping.
#
# Usage:
#   ./swap-installations.sh save <name>
#   ./swap-installations.sh load <name>
#   ./swap-installations.sh empty
#   ./swap-installations.sh primary-only
#   ./swap-installations.sh list
#   ./swap-installations.sh delete <name>

set -euo pipefail

# --- Resolve data directory (matches paths.ts logic) ---
if [[ "$(uname)" == "Darwin" ]]; then
  DATA_DIR="${HOME}/Library/Application Support/comfyui-desktop-2"
  CONFIG_DIR="$DATA_DIR"
else
  # Linux: XDG
  DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/comfyui-desktop-2"
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/comfyui-desktop-2"
fi

INSTALLATIONS_FILE="$DATA_DIR/installations.json"
SETTINGS_FILE="$CONFIG_DIR/settings.json"
PROFILES_DIR="$DATA_DIR/test-profiles"

ACTION="${1:-}"
NAME="${2:-}"

if [[ -z "$ACTION" ]]; then
  echo "Usage: $0 {save|load|empty|primary-only|list|delete} [name]" >&2
  exit 1
fi

# --- Warn if app is running ---
if [[ "$ACTION" != "list" ]]; then
  if pgrep -if "comfyui" > /dev/null 2>&1; then
    echo "WARNING: ComfyUI Launcher appears to be running. Close it before swapping."
    read -rp "Continue anyway? (y/N) " reply
    [[ "$reply" =~ ^[Yy]$ ]] || exit 0
  fi
fi

require_name() {
  if [[ -z "$NAME" ]]; then
    echo "Error: Profile name is required for '$ACTION'." >&2
    exit 1
  fi
}

profile_path() {
  echo "$PROFILES_DIR/$1.json"
}

backup_current() {
  if [[ -f "$INSTALLATIONS_FILE" ]]; then
    cp "$INSTALLATIONS_FILE" "$DATA_DIR/installations.json.bak"
    echo "Backed up current installations.json to installations.json.bak"
  fi
}

case "$ACTION" in
  save)
    require_name
    if [[ ! -f "$INSTALLATIONS_FILE" ]]; then
      echo "Error: No installations.json found at $INSTALLATIONS_FILE" >&2
      exit 1
    fi
    mkdir -p "$PROFILES_DIR"
    cp "$INSTALLATIONS_FILE" "$(profile_path "$NAME")"
    echo "Saved current installations.json as profile '$NAME'"
    ;;

  empty)
    backup_current
    printf '[]' > "$INSTALLATIONS_FILE"
    echo "Replaced installations.json with empty array (fresh state)"
    ;;

  primary-only)
    if [[ ! -f "$INSTALLATIONS_FILE" ]]; then
      echo "Error: No installations.json found at $INSTALLATIONS_FILE" >&2
      exit 1
    fi

    # Read primaryInstallId from settings.json
    PRIMARY_ID=""
    if [[ -f "$SETTINGS_FILE" ]]; then
      PRIMARY_ID=$(python3 -c "
import json, sys
with open('$SETTINGS_FILE') as f:
    s = json.load(f)
print(s.get('primaryInstallId', '') or '')
" 2>/dev/null || true)
    fi

    # Extract primary entry (or first eligible) using python3 for reliable JSON handling
    python3 -c "
import json, sys

with open('$INSTALLATIONS_FILE') as f:
    installs = json.load(f)

primary_id = '''$PRIMARY_ID'''
primary = None

if primary_id:
    matches = [i for i in installs if i.get('id') == primary_id]
    if matches:
        primary = matches[0]

if not primary:
    eligible = [i for i in installs if i.get('sourceId') not in ('desktop', 'cloud')]
    if eligible:
        primary = eligible[0]

if not primary:
    print('Error: No eligible primary installation found.', file=sys.stderr)
    sys.exit(1)

# Ensure install path exists
install_path = primary.get('installPath', '')
if install_path:
    import os
    if not os.path.exists(install_path):
        os.makedirs(install_path, exist_ok=True)
        sentinel = os.path.join(install_path, '.swap-test-sentinel')
        with open(sentinel, 'w') as sf:
            sf.write('created by swap-installations script')
        print(f'Created stub directory at {install_path}')

with open('$INSTALLATIONS_FILE', 'w') as f:
    json.dump([primary], f, indent=2)

print(f\"Kept only primary installation: {primary['name']} ({primary['id']})\")
"
    backup_current
    ;;

  load)
    require_name
    src="$(profile_path "$NAME")"
    if [[ ! -f "$src" ]]; then
      echo "Error: Profile '$NAME' not found. Use 'list' to see available profiles." >&2
      exit 1
    fi
    backup_current
    cp "$src" "$INSTALLATIONS_FILE"
    echo "Loaded profile '$NAME' as installations.json"
    ;;

  list)
    if [[ ! -d "$PROFILES_DIR" ]]; then
      echo "No profiles saved yet."
      exit 0
    fi
    shopt -s nullglob
    profiles=("$PROFILES_DIR"/*.json)
    shopt -u nullglob
    if [[ ${#profiles[@]} -eq 0 ]]; then
      echo "No profiles saved yet."
      exit 0
    fi
    echo "Saved profiles:"
    for p in "${profiles[@]}"; do
      name="$(basename "$p" .json)"
      count=$(python3 -c "import json; print(len(json.load(open('$p'))))" 2>/dev/null || echo "?")
      echo "  $name ($count installations)"
    done
    ;;

  delete)
    require_name
    target="$(profile_path "$NAME")"
    if [[ ! -f "$target" ]]; then
      echo "Error: Profile '$NAME' not found." >&2
      exit 1
    fi
    rm "$target"
    echo "Deleted profile '$NAME'"
    ;;

  *)
    echo "Unknown action: $ACTION" >&2
    echo "Usage: $0 {save|load|empty|primary-only|list|delete} [name]" >&2
    exit 1
    ;;
esac
