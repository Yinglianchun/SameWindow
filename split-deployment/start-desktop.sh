#!/bin/bash
# Container init for the browser-side half: virtual display -> window manager
# -> chromium (with a 2s respawn loop) -> VNC -> noVNC -> control server.
set -u
: "${SAMEWINDOW_DISPLAY:=:99}"
: "${SAMEWINDOW_SCREEN:=1440x900x24}"
: "${SAMEWINDOW_CDP_PORT:=9222}"
export DISPLAY="$SAMEWINDOW_DISPLAY"

[ -f /opt/novnc-web/cursor-state.json ] || \
  echo '{"sequence":0,"visible":false,"x":null,"y":null,"click":false,"durationMs":null,"animate":true}' \
  > /opt/novnc-web/cursor-state.json

Xvfb "$DISPLAY" -screen 0 "$SAMEWINDOW_SCREEN" -nolisten tcp &
sleep 1
openbox --sm-disable &

mkdir -p /data/chrome-profile
# Clear stale singleton locks: right after container start no real chromium can
# be running, so any Singleton* file is a leftover from an unclean shutdown of
# a previous container (chromium would otherwise refuse to start, claiming the
# profile is "in use by another computer").
rm -f /data/chrome-profile/Singleton* 2>/dev/null || true

# SAMEWINDOW_PROXY non-empty = route page traffic through that proxy (e.g. the
# SSH tunnel's SOCKS -> traffic egresses from your server, websites see the
# server's IP, not your home IP). Empty = direct connection.
# Array quoting matters: host-resolver-rules contains spaces and a `*`.
PROXY_ARGS=()
if [ -n "${SAMEWINDOW_PROXY:-}" ]; then
  PROXY_ARGS+=(--proxy-server="$SAMEWINDOW_PROXY")
fi

( while :; do
    chromium --user-data-dir=/data/chrome-profile \
      --no-first-run --no-default-browser-check --password-store=basic \
      --disable-session-crashed-bubble --hide-crash-restore-bubble \
      --remote-debugging-port="$SAMEWINDOW_CDP_PORT" --remote-debugging-address=127.0.0.1 \
      --no-sandbox --disable-dev-shm-usage \
      --dns-prefetch-disable --disable-quic \
      --webrtc-ip-handling-policy=disable_non_proxied_udp \
      --window-position=0,0 --start-maximized \
      "${PROXY_ARGS[@]}"
    sleep 2
  done ) &

x11vnc -display "$DISPLAY" -rfbport 5900 -localhost -forever -shared -nopw -noxdamage -repeat -quiet &
websockify --web /opt/novnc-web 0.0.0.0:6080 127.0.0.1:5900 &

exec node /opt/samewindow/control-server.mjs
