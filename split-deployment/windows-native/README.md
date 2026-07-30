# SameWindow for Windows — native mode

[中文说明](README.zh-CN.md)

This is the recommended split-deployment mode when the person uses Windows.
It runs a dedicated Chrome window, SameWindow's control server, and a
click-through transparent cursor layer directly on Windows. The agent can stay
on a remote server; only compact control calls cross an SSH reverse tunnel.

No Docker, WSL, VNC, or browser extension is required.

![SameWindow native Chrome with the human and agent cursors](../../docs/images/windows-native-dual-cursor.jpg)

```text
Windows PC                                      Remote server
┌────────────────────────────────────┐          ┌────────────────────────┐
│ dedicated Chrome + persistent profile         │ agent + SameWindow MCP │
│ native transparent two-cursor layer│  ssh -R  │                        │
│ control :6081 / lifecycle :6084 ───┼─────────→│ :16081 / :16082        │
└────────────────────────────────────┘          └────────────────────────┘
        the visible window stays local
```

## Why this became the Windows default

[Issue #4](https://github.com/Yinglianchun/SameWindow/issues/4) and the split
deployment contributed by fable5 × ElianeClair gave us the important idea:
**the visible frames do not need to travel with the agent**. Put the window
beside the person and leave the agent where it already lives.

Their Docker implementation remains the portable option for macOS, Linux, and
people who deliberately prefer container isolation. On Windows, however,
Docker/WSL adds another runtime, slower cold starts, and a second coordinate
system between the visible window and the desktop. The native mode follows the
same split architecture with fewer layers:

- existing Chrome or Edge, launched with a separate persistent profile;
- Node.js control and lifecycle services running directly on Windows;
- a native click-through overlay that follows the active Chrome tab and also
  works on new-tab and `chrome://` pages;
- accurate human and agent pointers without injecting UI into every webpage;
- an optional SOCKS privacy exit through the same SSH connection.

The Docker deployment is not deprecated or removed. It is documented as the
cross-platform alternative in [the split-deployment guide](../README.md).

## Requirements

- Windows 10 or 11
- Node.js 20+
- Google Chrome or Microsoft Edge
- Windows OpenSSH Client
- an SSH key accepted by the remote server
- PowerShell 5.1 (included with Windows)

All local services bind to `127.0.0.1`.

## Setup

From the repository root:

```powershell
cd split-deployment\windows-native
Copy-Item settings.example.json settings.json
notepad settings.json
```

At minimum, set the SSH destination:

```json
{
  "server": "your-user@your-server"
}
```

Useful settings:

| Setting | Meaning |
| --- | --- |
| `server` | SSH destination used by the reverse tunnel |
| `sshPort` | SSH port, default `22` |
| `identityFile` | Optional key path; blank uses `%USERPROFILE%\.ssh\id_ed25519` |
| `privacyExit` | `vps` routes page traffic through the server; `local` uses your normal connection |
| `chromePath` | Optional explicit Chrome/Edge executable |
| `homeUrl` | First page opened by the dedicated profile |

Start everything:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1
```

The first run installs the repository's `playwright-core` dependency if it is
missing. Chrome login data is stored only in
`split-deployment/windows-native/data/chrome-profile` and survives stops.

Stop the browser while keeping its profile:

```powershell
.\stop.ps1
```

Stop the browser, lifecycle service, and tunnel:

```powershell
.\stop.ps1 -All
```

## Remote server routing

Configure the environment that starts `src/mcp_server.py`:

```bash
SAMEWINDOW_CONTROL_URL=http://127.0.0.1:16081
SAMEWINDOW_LIFECYCLE_URL=http://127.0.0.1:16082
SAMEWINDOW_FALLBACK_CONTROL_URL=http://127.0.0.1:6081
SAMEWINDOW_FALLBACK_LIFECYCLE_URL=http://127.0.0.1:6082
```

The Windows browser is preferred whenever its tunnel is online. The original
VPS browser remains a manual fallback: ordinary MCP calls do not wake it;
`shared_browser_lifecycle_start` does.

If you do not keep a VPS browser, omit the two `FALLBACK` variables.

## Privacy exit

`privacyExit: "vps"` is the default. `tunnel.ps1` opens a local SOCKS5 listener
on `127.0.0.1:1080`, and the dedicated Chrome uses it. Websites and DNS then
see the server-side exit rather than the home connection. Chrome disables QUIC,
DNS prefetch, and non-proxied WebRTC UDP paths to avoid common bypasses.

The tunnel must be running for pages to load in this mode. Set
`privacyExit` to `local` if that tradeoff is not wanted.

## Troubleshooting

- **Pages do not load** — with `privacyExit: "vps"`, check that `tunnel.ps1`
  is running and the SSH server permits TCP forwarding.
- **The overlay is missing after switching tabs** — make sure the dedicated
  Chrome was launched by `launch.ps1`; ordinary personal Chrome windows are
  intentionally ignored.
- **Port already in use** — stop an older SameWindow or split-browser instance
  using ports `6081`, `6084`, or `9222`.
- **Windows shows an `rdclientax.dll` / Remote Desktop ActiveX error** — that
  comes from a broken WSLg `msrdc.exe`, not from SameWindow native mode. Close
  the WSL process or repair WSL; these scripts never invoke WSL or Remote
  Desktop.

## Credits

The native mode is maintained by 小雨 × Haven. Its architecture was prompted
by the split-deployment discussion in issue #4 and the Docker contribution by
fable5 × ElianeClair. Both modes remain part of SameWindow.
