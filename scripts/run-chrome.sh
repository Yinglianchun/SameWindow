#!/usr/bin/env bash
set -euo pipefail

: "${SAMEWINDOW_CHROME_BIN:=/usr/bin/google-chrome-stable}"
: "${SAMEWINDOW_DISPLAY:=:99}"
: "${SAMEWINDOW_HOME_URL:=https://www.google.com/}"
: "${SAMEWINDOW_CDP_PORT:=9222}"
export DISPLAY="$SAMEWINDOW_DISPLAY"

exec "$SAMEWINDOW_CHROME_BIN" \
  --user-data-dir=/var/lib/samewindow/chrome-profile \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$SAMEWINDOW_CDP_PORT" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --window-size=1440,900 \
  --start-maximized \
  "$SAMEWINDOW_HOME_URL"
