#!/usr/bin/env bash
#
# Installs the collector on the machine that is actually logged in to the
# accounts. It probes local files and pushes the finished numbers to a wallboard
# running somewhere else — no credential ever leaves this machine.
#
#   ./deploy/collector/install-collector.sh http://192.168.1.50:4000
#
set -euo pipefail

TARGET="${1:-${WALLBOARD_URL:-}}"
LABEL="com.local.aiwallboard-collector"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 http://<display-machine-ip>:4000" >&2
  exit 1
fi
if [[ ! "$TARGET" =~ ^https?:// ]]; then
  echo "target must start with http:// or https:// (got '$TARGET')" >&2
  exit 1
fi

cd "$PROJECT_DIR"

if [[ ! -f .env.local ]] || ! grep -q '^INGEST_TOKEN=' .env.local; then
  echo "INGEST_TOKEN is not set in $PROJECT_DIR/.env.local" >&2
  echo "generate one and put the *same* value on the display machine:" >&2
  echo "  echo \"INGEST_TOKEN=\$(openssl rand -hex 24)\" >> .env.local" >&2
  exit 1
fi

NODE="$(command -v node)"
[[ -x "$NODE" ]] || { echo "node not found on PATH" >&2; exit 1; }
[[ -x node_modules/.bin/tsx ]] || { echo "run 'npm install' first" >&2; exit 1; }

mkdir -p data "$HOME/Library/LaunchAgents"

echo "==> checking $TARGET is reachable"
if ! curl -sf -o /dev/null --max-time 5 "$TARGET/api/state"; then
  echo "warning: $TARGET/api/state did not answer — installing anyway, the collector will retry" >&2
fi

echo "==> one test push"
WALLBOARD_URL="$TARGET" "$NODE" node_modules/.bin/tsx scripts/collect.ts --once

sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
    -e "s|__NODE__|$NODE|g" \
    -e "s|__WALLBOARD_URL__|$TARGET|g" \
    deploy/collector/com.local.aiwallboard-collector.plist > "$PLIST"

echo "==> (re)loading the launch agent"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true

# bootout is asynchronous and bootstrap races it; without waiting, a reinstall
# can leave no agent loaded at all while still exiting 0.
for _ in $(seq 1 50); do
  launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break
  sleep 0.1
done

launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

sleep 2
if ! launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  echo "FAILED: the agent did not stay loaded. See data/collector.err.log" >&2
  exit 1
fi

echo
echo "collector installed → pushing to $TARGET every 60s"
echo "  logs:  tail -f $PROJECT_DIR/data/collector.log"
echo "  stop:  launchctl bootout gui/$UID/$LABEL"
