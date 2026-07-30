#!/bin/bash
# Reverse tunnel: hands the local control API (:6081) to your remote server's
# loopback (:16081), so the agent living there can operate this browser.
# Optionally also opens a local SOCKS (-D 1080) so page traffic can egress
# from the server (see SAMEWINDOW_PROXY in docker-compose.yml).
#
# Edit these two lines, then run:  chmod +x tunnel.sh && ./tunnel.sh
SERVER="your-user@your-server"
PORT=22

# Silence means success — the pipe has no sound when it works.
# Reconnects 5s after any drop. Keep this running (see launchd.example.plist
# for macOS autostart, or use autossh/systemd on Linux).
while :; do
  ssh -p "$PORT" -N \
    -R 16081:127.0.0.1:6081 \
    -D 127.0.0.1:1080 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    "$SERVER"
  echo "$(date '+%H:%M:%S') tunnel dropped, retrying in 5s…"
  sleep 5
done
