# SameWindow Split Deployment

[中文说明](README.zh-CN.md)

Run the **browser half** of SameWindow on the machine next to you; leave the
**agent half** on your remote server. An SSH reverse tunnel stitches them
together.

## Choose the local browser

| Local machine | Recommended mode |
| --- | --- |
| Windows 10/11 | [Native Chrome + transparent cursor layer](windows-native/README.md) — no Docker, WSL, or VNC |
| macOS / Linux | Docker + Chromium + noVNC, documented below |
| Windows with a deliberate container preference | Docker remains supported as an optional mode |

This deployment mode was contributed by fable5 × ElianeClair and is now
maintained in the official [SameWindow](https://github.com/Yinglianchun/SameWindow)
repository. It changes *where* the window lives without changing who shares it.

Issue #4 and that contribution supplied the architectural insight: browser
frames belong beside the person, while tiny agent commands can cross the
network. We then chose a native Windows implementation as the Windows default
because putting Docker/WSL between a desktop window and its transparent cursor
adds cold-start cost, resource use, and coordinate complexity. The Docker
implementation is still the portable, isolated alternative—not a deprecated
path.

## Why

SameWindow's default layout runs everything on a VPS, and you watch the screen
remotely. That is perfect when the VPS is close to you. It falls apart when it
isn't: VNC pushes *frames* across the wire and every frame needs a round trip,
so at 300 ms RTT the shared desktop becomes a slideshow at exactly the moment
you wanted to browse together.

The fix is to notice the two halves have opposite needs:

- **The screen** is heavy traffic and belongs *next to the human* — localhost,
  zero latency, immune to evening congestion.
- **The agent's commands** are a few hundred bytes of CDP calls and don't care
  about 300 ms — they can cross an ocean.

```
Your machine (laptop / home box)              Remote server
┌────────────────────────────────┐            ┌──────────────────────────┐
│ docker: Xvfb → Chromium(CDP)   │  ssh -R    │ agent (MCP client)       │
│   x11vnc → noVNC :6080 ────────┼── tunnel ──┤   SAMEWINDOW_CONTROL_URL │
│   control server :6081 ────────┼─→ :16081   │   = http://127.0.0.1:16081│
└──────────────┬─────────────────┘            └──────────────────────────┘
               │ localhost (zero latency)
        your browser: http://127.0.0.1:6080/samewindow.html
```

Everything you love survives the split: both cursors, the click ripples, the
browse-together toggle, the sensitive-page guard.

## Docker quick start

Prereqs: Docker (Desktop or OrbStack on macOS — Apple Silicon works, the image
uses Debian's arm64-native Chromium), and SSH key access to your server.

```bash
git clone https://github.com/Yinglianchun/SameWindow.git
cd SameWindow/split-deployment
docker compose up -d --build          # first build takes a few minutes
```

Open <http://127.0.0.1:6080/samewindow.html> — the shared desktop, at your
screen's own frame rate.

Then hand the control API to your server:

```bash
# edit SERVER= and PORT= in tunnel.sh first
chmod +x tunnel.sh && ./tunnel.sh     # silence = working; keep it running
```

On the server, configure the local tunnel as the preferred browser and the
original VPS browser as a manual fallback:

```bash
SAMEWINDOW_CONTROL_URL=http://127.0.0.1:16081
SAMEWINDOW_LIFECYCLE_URL=
SAMEWINDOW_FALLBACK_CONTROL_URL=http://127.0.0.1:6081
SAMEWINDOW_FALLBACK_LIFECYCLE_URL=http://127.0.0.1:6082
```

Ordinary browser tools use the local browser while it is online. If the local
machine is asleep and the VPS browser is stopped, they return a clear error and
do **not** wake anything. The agent must explicitly call
`shared_browser_lifecycle_start`; only then does SameWindow start the VPS
fallback. Temporary refs are tagged `local:` or `vps:`; a scoped ref such as
`s42:e1` therefore becomes `local:s42:e1` and cannot be used accidentally in
the other Chrome.

Put these values in the environment used by `mcp_server.py` (or
`/etc/samewindow.env` for the installed HTTP MCP service). For tunnel autostart
on macOS see `launchd.example.plist`; on Linux use autossh or a systemd user
unit.

## Privacy exit (optional, recommended)

Moving the browser home changes who sees your IP: in the original layout
websites saw the *server's* IP; with a bare local browser they would see your
*home* IP. To keep the original property, `tunnel.sh` also opens a local SOCKS
(`-D 1080`) — uncomment `SAMEWINDOW_PROXY` in `docker-compose.yml` and page
traffic egresses from your server again. If your home IP matters to you,
treat this as part of the standard setup, not an extra.
The browser disables DNS prefetch and QUIC, and the SOCKS5 proxy resolves page
hostnames on the server side without Chromium's unsupported resolver-rule flag.

The exposure map, so you can audit rather than trust:

| Who could see an IP                     | Proxy ON (recommended)              | Proxy OFF                    |
| --------------------------------------- | ----------------------------------- | ---------------------------- |
| **Your AI provider (Anthropic/OpenAI…)**| **server IP — agent never moved**   | **server IP — agent never moved** |
| Websites you visit                      | server IP                           | **home IP**                  |
| DNS resolvers                           | via server (forced through proxy)   | **your local network's DNS** |
| WebRTC / STUN                           | barred from bypassing (both modes)  | barred from bypassing        |
| Your own server                         | home IP (it's your machine)         | same                         |
| Your ISP                                | "connects to own server", encrypted | sees domains you browse      |

### Your AI provider never sees your home IP

Worth its own heading, because for many of us this is the IP that actually
matters. The agent half never moves in this deployment: every call to your
LLM provider (Anthropic, OpenAI, …) still originates from your **server**,
exactly as before the split — in *both* proxy modes. Your home IP cannot
enter the AI-side traffic, because the agent simply isn't on this machine.

This is also a concrete reason to prefer splitting over moving the whole
stack home: run the agent locally and your provider suddenly sees your local
network instead — which matters a great deal if your provider is
region-sensitive about accounts. The split keeps the browser next to you and
the account exactly where it was.

Verify with your own eyes: open `ipify.org` inside the shared browser — it
must print the server's IP, not your home IP. The screen never touches the
proxy — frames stay on localhost either way.

Note: with the proxy enabled, pages load only while the tunnel is up.

## Hardening

The tunnel key only needs port forwarding. On the server, restrict it in
`~/.ssh/authorized_keys`:

```
restrict,port-forwarding,permitlisten="16081" ssh-ed25519 AAAA... you@machine
```

A stolen laptop key then opens no shell. All container ports bind to
127.0.0.1 on both machines; nothing faces the network.

## Troubleshooting

- **Chromium loops with "profile in use by another computer"** — a stale
  singleton lock from an unclean shutdown. The container clears it on start
  automatically; if you hit it in other setups: delete `Singleton*` from the
  profile directory.
- **Pages won't load but the desktop renders** — proxy is enabled and the
  tunnel isn't up. Start `tunnel.sh` (or comment out `SAMEWINDOW_PROXY`).
- **Laptop lid closed = desktop asleep** — the tunnel drops and reconnects on
  wake; the agent's probes fail gracefully in between. This is by design.
- **Verify the mask**: open `ipify.org` inside the shared browser — it should
  print your server's IP, not your home IP.

## Credits & license

- SameWindow — 小雨 × Haven ([official repository](https://github.com/Yinglianchun/SameWindow)).
  Please share the original project by linking there.
- Split deployment & docs: Fable 5
- Manual fallback routing and upstream integration: 小雨 × Haven
- License: same as upstream — [SameWindow Noncommercial Share-Alike License 1.0](../LICENSE).
