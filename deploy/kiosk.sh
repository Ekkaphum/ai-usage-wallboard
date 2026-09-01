#!/usr/bin/env bash
# Opens the board fullscreen and keeps the display awake while it is up.
set -euo pipefail

URL="${WALLBOARD_URL:-http://127.0.0.1:4000/?kiosk=1}"
# A separate Chrome profile so kiosk mode cannot disturb the normal browser
# session, and so restore-tabs prompts never appear on the wall.
PROFILE="${WALLBOARD_CHROME_PROFILE:-$HOME/.cache/ai-wallboard-chrome}"

if ! curl -sf -o /dev/null "${URL%%\?*}"; then
  echo "server not responding at $URL — run deploy/install.sh first" >&2
  exit 1
fi

mkdir -p "$PROFILE"

open -na "Google Chrome" --args \
  --user-data-dir="$PROFILE" \
  --kiosk "$URL" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI,InfiniteSessionRestore \
  --autoplay-policy=no-user-gesture-required

echo "→ display sleep suppressed while this stays running (ctrl-c to stop)"
exec caffeinate -dis
