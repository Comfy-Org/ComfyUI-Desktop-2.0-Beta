#!/usr/bin/env bash
#
# Trigger the first-use takeover in specific scenarios for QA.
#
# Flips `firstUseCompleted` in settings.json (and optionally edits
# installations.json) so the next launcher start re-runs the first-use
# takeover in a chosen state. The `firstUseDetection` module reads
# installations.json to compute { skipPick, hasLegacyDesktop }:
#
#   skipPick = true  ⇨ ANY install present beyond Cloud / Legacy Desktop.
#                      T&C accept skips the cloud-vs-local fork and emits
#                      `complete-skip` (drops user on the chooser body —
#                      bug #476 was Cloud being auto-launched here).
#   skipPick = false ⇨ Only Cloud / Legacy Desktop. T&C accept advances to
#                      the cloud-vs-local pick step.
#   hasLegacyDesktop ⇨ A `sourceId: 'desktop'` install was auto-tracked.
#                      Picking Local opens the migrate-vs-install-new
#                      sub-step.
#
# The app should be closed before running these — settings.json gets
# rewritten in-flight by the running app and would clobber any change.
#
# Usage:
#   ./first-use.sh status     # Print current state + computed skipPick/hasLegacyDesktop
#   ./first-use.sh reset      # Set firstUseCompleted=false (current installs)
#   ./first-use.sh fresh      # firstUseCompleted=false + strip non-cloud/non-desktop installs
#   ./first-use.sh returning  # firstUseCompleted=false + ensure standalone install (#476 scenario)
#   ./first-use.sh legacy     # firstUseCompleted=false + ensure desktop install
#   ./first-use.sh complete   # Set firstUseCompleted=true (clears takeover)

set -euo pipefail

# --- Resolve data + config directories (matches paths.ts logic) ---
if [[ "$(uname)" == "Darwin" ]]; then
  DATA_DIR="${HOME}/Library/Application Support/comfyui-desktop-2"
  CONFIG_DIR="$DATA_DIR"
else
  DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/comfyui-desktop-2"
  CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/comfyui-desktop-2"
fi

INSTALLATIONS_FILE="$DATA_DIR/installations.json"
SETTINGS_FILE="$CONFIG_DIR/settings.json"

# Sentinel marker stamped on installs the script adds itself, so repeat
# runs reuse the entry rather than stacking duplicates.
SENTINEL_KEY="_firstUseHelperSentinel"
RETURNING_SENTINEL="returning"
LEGACY_SENTINEL="legacy"

ACTION="${1:-}"
if [[ -z "$ACTION" ]]; then
  echo "Usage: $0 {status|reset|fresh|returning|legacy|complete}" >&2
  exit 1
fi

if [[ "$ACTION" != "status" ]]; then
  if pgrep -if "comfyui" > /dev/null 2>&1; then
    echo "WARNING: ComfyUI Launcher appears to be running. Close it first — settings.json will be overwritten on the next save."
    read -rp "Continue anyway? (y/N) " reply
    [[ "$reply" =~ ^[Yy]$ ]] || exit 0
  fi
fi

backup_file() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  # Timestamped backups so repeat runs never clobber the previous
  # snapshot. The legacy single-slot .bak lost the original install
  # metadata when this script was invoked twice in a row — the second
  # run backed up the already-filtered file over the only copy of the
  # real one. The plain .bak is kept too so quick "restore last"
  # tooling still works, but only if it doesn't already exist (so
  # the original is preserved across repeat invocations).
  local stamp
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  local stamped="${path}.${stamp}.bak"
  cp "$path" "$stamped"
  if [[ ! -f "${path}.bak" ]]; then
    cp "$path" "${path}.bak"
  fi
  echo "Backed up $(basename "$path") to $(basename "$stamped")"
}

set_first_use_completed() {
  local value="$1"
  mkdir -p "$CONFIG_DIR"
  backup_file "$SETTINGS_FILE"
  python3 - "$SETTINGS_FILE" "$value" <<'PY'
import json, os, sys
path, value = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        if raw:
            data = json.loads(raw)
    except Exception as exc:
        print(f"WARN: failed to parse {path}: {exc}", file=sys.stderr)
        data = {}
if not isinstance(data, dict):
    data = {}
data['firstUseCompleted'] = (value == 'true')
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
print(f"Set firstUseCompleted = {value}")
PY
}

categorise_and_print_status() {
  python3 - "$SETTINGS_FILE" "$INSTALLATIONS_FILE" <<'PY'
import json, os, sys
settings_path, installs_path = sys.argv[1], sys.argv[2]

settings = {}
if os.path.exists(settings_path):
    try:
        with open(settings_path) as f:
            raw = f.read().strip()
        if raw:
            settings = json.loads(raw)
    except Exception:
        pass

installs = []
if os.path.exists(installs_path):
    try:
        with open(installs_path) as f:
            raw = f.read().strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                installs = parsed
    except Exception:
        pass

cloud = sum(1 for i in installs if i.get('sourceId') == 'cloud')
desktop = sum(1 for i in installs if i.get('sourceId') == 'desktop')
other = sum(1 for i in installs if i.get('sourceId') not in ('cloud', 'desktop'))
skip_pick = other > 0
has_legacy = desktop > 0
completed = settings.get('firstUseCompleted')

print(f"settings.json:        {settings_path}")
print(f"  firstUseCompleted = {completed}")
print(f"installations.json:   {installs_path}")
print(f"  total           = {len(installs)}")
print(f"  cloud           = {cloud}")
print(f"  desktop         = {desktop}")
print(f"  other (local …) = {other}")
print()
print("On next launch the takeover would receive:")
print(f"  skipPick         = {skip_pick}")
print(f"  hasLegacyDesktop = {has_legacy}")
print()
if not completed:
    if skip_pick:
        print("Takeover WILL fire and Accept TOS will emit 'complete-skip' "
              "(bug #476 scenario — must drop into chooser, NOT auto-launch Cloud).")
    else:
        print("Takeover WILL fire and Accept TOS will advance to the cloud-vs-local pick step.")
else:
    print("Takeover will NOT fire (firstUseCompleted=true). "
          "Use 'reset' / 'fresh' / 'returning' / 'legacy' to re-trigger.")
PY
}

mutate_installs_filter_to_cloud_desktop_only() {
  mkdir -p "$DATA_DIR"
  backup_file "$INSTALLATIONS_FILE"
  python3 - "$INSTALLATIONS_FILE" "$SENTINEL_KEY" "$LEGACY_SENTINEL" <<'PY'
import json, os, sys
path, key, legacy_sentinel = sys.argv[1], sys.argv[2], sys.argv[3]
installs = []
if os.path.exists(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                installs = parsed
    except Exception:
        pass
kept = [
    i for i in installs
    if i.get('sourceId') in ('cloud', 'desktop') and i.get(key) != legacy_sentinel
]
with open(path, 'w') as f:
    json.dump(kept, f, indent=2)
print(f"Filtered installations.json down to {len(kept)} entry/entries (cloud / non-helper desktop only).")
PY
}

mutate_installs_ensure_standalone() {
  mkdir -p "$DATA_DIR"
  local stub_dir="$DATA_DIR/first-use-helper-fake-standalone"
  mkdir -p "$stub_dir"
  echo "fake install seeded by first-use.sh" > "$stub_dir/.first-use-helper-sentinel"
  backup_file "$INSTALLATIONS_FILE"
  python3 - "$INSTALLATIONS_FILE" "$SENTINEL_KEY" "$RETURNING_SENTINEL" "$stub_dir" <<'PY'
import json, os, sys, time
path, key, sentinel, stub_dir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
installs = []
if os.path.exists(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                installs = parsed
    except Exception:
        pass
has_other = any(
    i.get('sourceId') not in ('cloud', 'desktop')
    for i in installs
)
if has_other:
    print("A non-cloud, non-desktop install is already present — skipPick will already be true. No edit needed.")
else:
    ms = int(time.time() * 1000)
    fake = {
        "id": f"inst-firstuse-helper-{ms}",
        "name": "First-Use Helper Standalone",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "sourceId": "standalone",
        "installPath": stub_dir,
        "status": "installed",
        key: sentinel,
    }
    installs.append(fake)
    with open(path, 'w') as f:
        json.dump(installs, f, indent=2)
    print("Added a sentinel standalone install (sourceId=standalone) so skipPick=true.")
PY
}

mutate_installs_ensure_desktop() {
  mkdir -p "$DATA_DIR"
  local stub_dir="$DATA_DIR/first-use-helper-fake-desktop"
  mkdir -p "$stub_dir"
  echo "fake desktop install seeded by first-use.sh" > "$stub_dir/.first-use-helper-sentinel"
  backup_file "$INSTALLATIONS_FILE"
  python3 - "$INSTALLATIONS_FILE" "$SENTINEL_KEY" "$LEGACY_SENTINEL" "$stub_dir" <<'PY'
import json, os, sys, time
path, key, sentinel, stub_dir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
installs = []
if os.path.exists(path):
    try:
        with open(path) as f:
            raw = f.read().strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                installs = parsed
    except Exception:
        pass
has_desktop = any(i.get('sourceId') == 'desktop' for i in installs)
if has_desktop:
    print("A desktop install is already present — hasLegacyDesktop will already be true. No edit needed.")
else:
    ms = int(time.time() * 1000)
    fake = {
        "id": f"inst-firstuse-helper-desktop-{ms}",
        "name": "ComfyUI Legacy Desktop (helper)",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "sourceId": "desktop",
        "installPath": stub_dir,
        "launchMode": "external",
        "status": "installed",
        key: sentinel,
    }
    installs.append(fake)
    with open(path, 'w') as f:
        json.dump(installs, f, indent=2)
    print("Added a sentinel desktop install (sourceId=desktop) so hasLegacyDesktop=true.")
PY
}

case "$ACTION" in
  status)
    categorise_and_print_status
    ;;
  reset)
    set_first_use_completed false
    echo "Done. Next launch will re-run the first-use takeover with current installs."
    ;;
  fresh)
    mutate_installs_filter_to_cloud_desktop_only
    set_first_use_completed false
    echo "Resulting state: skipPick=false. Cloud-vs-local pick will show."
    ;;
  returning)
    mutate_installs_ensure_standalone
    set_first_use_completed false
    echo "Bug #476 scenario armed: Accept TOS should drop into the chooser without auto-launching Cloud."
    ;;
  legacy)
    mutate_installs_ensure_desktop
    set_first_use_completed false
    echo "Pick Local in the takeover to surface the migrate-vs-install-new sub-step."
    ;;
  complete)
    set_first_use_completed true
    echo "Done. First-use takeover will NOT fire on next launch."
    ;;
  *)
    echo "Unknown action: $ACTION" >&2
    echo "Usage: $0 {status|reset|fresh|returning|legacy|complete}" >&2
    exit 1
    ;;
esac
