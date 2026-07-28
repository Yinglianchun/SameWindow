#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root: sudo ./scripts/install-ubuntu.sh" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR=/opt/samewindow
STATE_DIR=/var/lib/samewindow
CONFIG_FILE=/etc/samewindow.env

required=(node npm python3 systemctl Xvfb openbox x11vnc websockify)
missing=()
for command_name in "${required[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
done
if ((${#missing[@]})); then
  echo "Missing required commands: ${missing[*]}" >&2
  echo "See the prerequisites in README.md." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(`.`)[0])')"
if ((node_major < 20)); then
  echo "Node.js 20 or newer is required (found $(node --version))." >&2
  exit 1
fi

if [[ ! -d /usr/share/novnc ]]; then
  echo "Could not find the noVNC web root at /usr/share/novnc." >&2
  exit 1
fi
NOVNC_ROOT=/usr/share/novnc

if ! id samewindow >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin samewindow
fi

install -d -m 0755 "$INSTALL_DIR" "$INSTALL_DIR/src" "$INSTALL_DIR/web" \
  "$INSTALL_DIR/scripts" "$INSTALL_DIR/deploy/systemd"
install -d -o samewindow -g samewindow -m 0750 "$STATE_DIR" \
  "$STATE_DIR/chrome-profile" "$STATE_DIR/runtime"
install -d -o samewindow -g samewindow -m 0755 "$STATE_DIR/novnc-web"

install -m 0644 "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" "$INSTALL_DIR/"
install -m 0644 "$REPO_DIR/requirements.txt" "$INSTALL_DIR/"
cp -a "$REPO_DIR/src/." "$INSTALL_DIR/src/"
cp -a "$REPO_DIR/web/." "$INSTALL_DIR/web/"
cp -a "$REPO_DIR/scripts/." "$INSTALL_DIR/scripts/"
cp -a "$REPO_DIR/deploy/systemd/." "$INSTALL_DIR/deploy/systemd/"
chmod 0755 "$INSTALL_DIR/scripts/"*.sh

if [[ ! -f "$CONFIG_FILE" ]]; then
  install -m 0644 "$REPO_DIR/.env.example" "$CONFIG_FILE"
fi

chrome_bin="$(
  . "$CONFIG_FILE"
  printf '%s' "${SAMEWINDOW_CHROME_BIN:-/usr/bin/google-chrome-stable}"
)"
if [[ ! -x "$chrome_bin" ]]; then
  echo "Chrome executable is missing: $chrome_bin" >&2
  echo "Install Google Chrome/Chromium and update SAMEWINDOW_CHROME_BIN in $CONFIG_FILE." >&2
  exit 1
fi

cd "$INSTALL_DIR"
npm ci --omit=dev
python3 -m venv "$INSTALL_DIR/.venv"
"$INSTALL_DIR/.venv/bin/pip" install --disable-pip-version-check -r requirements.txt

cp -a "$NOVNC_ROOT/." "$STATE_DIR/novnc-web/"
install -o samewindow -g samewindow -m 0644 \
  "$INSTALL_DIR/web/novnc/samewindow.html" \
  "$INSTALL_DIR/web/novnc/agent-cursor.js" \
  "$INSTALL_DIR/web/novnc/user-cursor.js" \
  "$INSTALL_DIR/web/novnc/watch-mode.js" \
  "$STATE_DIR/novnc-web/"
if [[ ! -f "$STATE_DIR/novnc-web/cursor-state.json" ]]; then
  cat > "$STATE_DIR/novnc-web/cursor-state.json" <<'JSON'
{
  "available": false,
  "inside": false,
  "x": null,
  "y": null,
  "buttons": 0,
  "pointerType": "mouse",
  "receivedAt": null
}
JSON
  chown samewindow:samewindow "$STATE_DIR/novnc-web/cursor-state.json"
  chmod 0644 "$STATE_DIR/novnc-web/cursor-state.json"
fi
node "$INSTALL_DIR/web/novnc/patch-novnc.mjs" "$STATE_DIR/novnc-web/vnc.html"
chown -R samewindow:samewindow "$STATE_DIR"

install -m 0644 "$INSTALL_DIR/deploy/systemd/"*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now samewindow-lifecycle.service

echo
echo "SameWindow is installed."
echo "Dashboard: http://127.0.0.1:6082"
echo "The shared browser remains stopped until you press Start or call its lifecycle tool."
echo "Optional HTTP MCP: systemctl enable --now samewindow-mcp.service"
