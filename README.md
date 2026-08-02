# SameWindow

**One browser. Two sets of hands.**

[![License](https://img.shields.io/badge/license-NC--SA%201.0-6d5f74)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4f6d7a)
![Deployment](https://img.shields.io/badge/deployment-self--hosted-52796f)
![Protocol](https://img.shields.io/badge/protocol-MCP-7a6f9b)

[中文介绍：不是让 AI 替你上网，是把网页放到你们之间](README.zh-CN.md)

SameWindow runs a persistent, dedicated Chrome and lets a person and an AI
agent use that exact browser together. The window can live on a Linux VPS and
be viewed through noVNC, or run natively beside the person in split mode. The
agent reads semantic snapshots and acts through small MCP tools. Both sides
share the same tabs, history, focus, and authenticated browser profile.

SameWindow is the public shared-browser core only. It does not include a chat
client, personal assistant prompts, private APIs, or any accounts.

## What it looks like

**Windows native mode — one real Chrome window, human and agent cursors**

![SameWindow Windows native browser with two visible cursors](docs/images/windows-native-dual-cursor.jpg)

**The VPS browser can sleep until it is explicitly needed**

![SameWindow sleeping browser lifecycle dashboard](docs/images/vps-sleep-dashboard.jpg)

**A self-hosted Bridge can build a more ambient “browse together” experience**

![SameWindow integrated with a self-hosted browse-together and chat interface](docs/images/browse-together-host-integration.jpg)

The last screenshot shows our private host integration as an example; the chat
client is not part of this public repository.

## What it includes

- A visible Chrome desktop: Xvfb → Openbox → Chrome → x11vnc → noVNC
- A Playwright/CDP control service with tab, snapshot, click, type, key, and
  automatic visible cursor feedback
- A Python MCP façade for agent clients
- A small start/stop dashboard so the heavy browser stack can sleep
- Optional “Browse together” semantic events for host integrations, covering
  deliberate clicks, dwell, stable page text, and near-pointer moments
- A persistent, dedicated Chrome profile

```text
Person ── SSH tunnel ── noVNC ───────┐
                                     ├── the same Chrome profile
Agent  ── MCP ──────── Playwright ───┘
```

## Safety model

All services bind to `127.0.0.1` by default. SameWindow intentionally has no
Internet-facing authentication layer: use SSH forwarding or another
authenticated private transport and never expose ports `6080`–`6083` publicly.

The agent cannot access cookies, browser storage, arbitrary JavaScript
evaluation, arbitrary CSS selectors, or screenshots through the public tools.
Actions use snapshot-scoped temporary references such as `s42:e1`. A new
snapshot invalidates the previous element refs for that tab, while the latest
refs for other tabs remain valid. The snapshot also returns `snapshotId` for
diagnostics, but actions only need the returned ref. An explicitly supplied
stale tab ref is rejected instead of silently falling back to another tab.
Clicks also fail fast with an `obstructed` error and a compact `coveredBy`
summary when an overlay receives the target point. Browser actionability
timeouts are returned as action errors with the Playwright reason, not as a
misleading gateway `504`. The expected flow is still for the person to sign in
before enabling browse-together mode; this path handles expired sessions and
ordinary overlays without asking the agent to cross that boundary.
Login, password,
one-time-code, identity, checkout, and payment pages are blocked from snapshots
and actions by default.

See [SECURITY.md](SECURITY.md) before deploying.

## Requirements

A small Ubuntu 22.04/24.04 server with:

- Node.js 20+
- Python 3.10+
- Google Chrome or Chromium
- `xvfb`, `openbox`, `x11vnc`, `novnc`, `websockify`, `dbus-x11`, and
  `python3-venv`

For example:

```bash
sudo apt update
sudo apt install -y xvfb openbox x11vnc novnc websockify dbus-x11 python3-venv
```

Install Node.js 20+ and Chrome using their official packages. If the Chrome
binary is not `/usr/bin/google-chrome-stable`, change
`SAMEWINDOW_CHROME_BIN` in `.env.example` before installation or in
`/etc/samewindow.env` afterward.

## Install

```bash
git clone https://github.com/Yinglianchun/SameWindow.git
cd SameWindow
sudo ./scripts/install-ubuntu.sh
```

The installer creates:

- application files in `/opt/samewindow`
- the browser profile and noVNC state in `/var/lib/samewindow`
- configuration in `/etc/samewindow.env`
- systemd units named `samewindow-*`

It starts only the lightweight lifecycle dashboard. The browser itself starts
when you press **Start** or call `shared_browser_lifecycle_start`.

## Open the shared window

Forward the three viewer/control ports from your computer:

```bash
ssh -N \
  -L 6080:127.0.0.1:6080 \
  -L 6081:127.0.0.1:6081 \
  -L 6082:127.0.0.1:6082 \
  your-user@your-server
```

Then open <http://127.0.0.1:6082>. The dashboard starts and stops the shared
browser without deleting its profile.

If the VPS is far away, the optional
[split deployment](split-deployment/README.md) keeps the agent on the server
but runs the visible browser beside the person. Frames stay on localhost while
small control calls cross an SSH reverse tunnel. The original VPS Chrome can
remain asleep as a manual fallback; ordinary browser calls never wake it.

For Windows, use the
[native Chrome + transparent cursor layer](split-deployment/windows-native/README.md)
first: it needs no Docker, WSL, or VNC. Docker remains the cross-platform
option for macOS, Linux, and users who prefer container isolation.

## Connect an MCP client

The simplest remote setup uses MCP over SSH stdio, so no MCP port needs to be
opened:

```json
{
  "mcpServers": {
    "samewindow": {
      "command": "ssh",
      "args": [
        "-T",
        "your-user@your-server",
        "/opt/samewindow/.venv/bin/python",
        "/opt/samewindow/src/mcp_server.py",
        "--transport",
        "stdio"
      ]
    }
  }
}
```

An optional loopback-only streamable HTTP service is also installed:

```bash
sudo systemctl enable --now samewindow-mcp.service
ssh -N -L 6083:127.0.0.1:6083 your-user@your-server
```

Its endpoint is `http://127.0.0.1:6083/mcp`. It has no application-level auth;
the SSH tunnel is part of the security boundary.

## Deliberately small MCP surface

SameWindow exposes 12 core MCP tools by default. It intentionally does not
turn every internal control endpoint into an agent tool:

| Tool | Default | Why |
| --- | --- | --- |
| `shared_browser_screenshot` | Removed | The person already sees the window, while agents should use compact semantic snapshots. Sending an image into a particular chat is a host/client responsibility, not a portable browser tool. |
| `shared_browser_cursor_move` | Removed | Ref-based click and type actions already move the visible agent cursor automatically. A separate cosmetic movement call adds noise. |
| `shared_browser_user_cursor` | Removed | Raw pointer polling is noisy, quickly becomes stale, and duplicates the deliberate semantic-event channel. |
| `shared_browser_watch_set` | Removed | Browse-together observation is consent-controlled by the person from the viewer; the agent should not enable it. |
| `shared_browser_watch_status` | Opt-in | Useful only for clients that actively consume browse-together events. |
| `shared_browser_events` | Opt-in | Polling is valuable for an active agent loop, but unnecessary overhead for ordinary browser control. |

To expose the two read-only browse-together polling tools, set:

```bash
SAMEWINDOW_ENABLE_BROWSE_TOGETHER_MCP=1
```

For the installed HTTP MCP service, add it to `/etc/samewindow.env` and restart
`samewindow-mcp.service`. For SSH stdio, pass the variable through the remote
command or configure it in the remote process environment.

The person must still turn on **Browse together** in the noVNC viewer. An MCP
client can then call `shared_browser_events` repeatedly during an active agent
run. This does not make ChatGPT or another client permanently proactive:
after the response/run ends, continued observation requires the host
application to schedule another turn. Host integrations can also consume the
loopback control API directly without expanding the model-facing tool list.

Browse-together emits a `page_change` preview with the title and main page
content after five stable seconds. At fifteen stable seconds, a deduplicated
`page_text` event adds fuller visible text, including comments when the page
renders them. Sensitive forms and authentication or payment pages remain
excluded.

## Typical agent flow

1. Check `shared_browser_lifecycle_status`; start it if needed.
2. Call `shared_browser_snapshot` on the visible tab.
3. Click or type by copying a returned snapshot-scoped element reference
   exactly; no extra snapshot parameter is required.
4. Take a new snapshot after navigation or a major page change.
5. Let the person enter secrets manually in the visible viewer.
6. Stop the browser only when the person is finished or resources should be
   released.

If no `tab_ref` is supplied, snapshots follow the actually focused/visible tab
rather than a stale cached selection.

## Development

```bash
npm install
python -m venv .venv
.venv/bin/pip install -r requirements.txt
npm run check
python -m py_compile src/mcp_server.py
python tests/mcp_smoke.py
python tests/router_test.py
./scripts/check-secrets.sh
```

The Node tests start the loopback services on temporary ports; they do not need
Chrome or systemd. Full end-to-end verification requires a Linux host with the
desktop dependencies above.

## License

SameWindow 0.2.0 and later are available under the
[SameWindow Noncommercial Share-Alike License 1.0](LICENSE).

You may use and privately modify SameWindow for noncommercial purposes. You
may also publish a version with material functional changes when the complete
corresponding source is freely available, the changes and original project are
clearly identified, and the entire modified version remains under the same
license.

Commercial use is not permitted. Mirroring, re-uploading, or redistributing an
unmodified or substantially unmodified copy is also not permitted; share the
[Official Repository](https://github.com/Yinglianchun/SameWindow) instead.

This is a source-available license, not an OSI-approved open-source license.
Versions released before 0.2.0 remain under the license that accompanied those
versions. Third-party dependencies remain under their respective licenses.
