#!/usr/bin/env bash
# Installs the wallboard as a launchd agent that survives reboots.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.local.aiwallboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

if [ -z "$NODE" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi

echo "→ building"
cd "$PROJECT_DIR"
npm run build

echo "→ writing $PLIST"
mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/data"
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" -e "s|__NODE__|$NODE|g" \
  "$PROJECT_DIR/deploy/com.local.aiwallboard.plist" > "$PLIST"

# bootout first so re-running this script is an update, not an error
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"

echo "→ waiting for the server"
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:4000/api/state; then
    echo "✓ running at http://127.0.0.1:4000"
    echo "  logs: $PROJECT_DIR/data/wallboard.log"
    echo "  stop: launchctl bootout gui/$UID/$LABEL"
    echo "  open the screen: $PROJECT_DIR/deploy/kiosk.sh"
    exit 0
  fi
  sleep 1
done

echo "✕ did not come up — check $PROJECT_DIR/data/wallboard.err.log" >&2
exit 1
