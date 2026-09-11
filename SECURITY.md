# Security

SameWindow gives an agent meaningful control over a real browser. Treat access
to its control plane as access to the browser profile.

## Safe deployment

- Keep ports `6080`–`6083` bound to `127.0.0.1`.
- Reach the viewer through SSH port forwarding or another authenticated private
  transport. Do not publish these ports directly to the Internet.
- Use a dedicated Chrome profile and dedicated accounts with minimal privileges.
- Enter passwords, one-time codes, recovery codes, identity data, and payment
  details yourself in the visible viewer.
- Leave `SAMEWINDOW_ALLOW_SENSITIVE_AUTOMATION=0`. The override exists for
  developers testing their own pages; it removes an important guardrail.
- Remember that a persistent Chrome profile contains authenticated sessions.
  Protect `/var/lib/samewindow/chrome-profile` and the host itself.

The public control and MCP surfaces do not expose screenshots. Browse-together
events are kept in a bounded in-memory queue and disappear when the control
service stops.

Social readers use the same sensitive-page guard, including visible sensitive
inputs in open shadow roots, plus platform login/challenge checks. They navigate
and scroll but do not post, comment, or like. Full post URLs are restricted to
HTTPS X/Twitter and Xiaohongshu hosts. A retained list never falls back to the
first card if its requested post disappears. Browser/profile access remains
privileged even when a particular tool is read-only.

Accessibility snapshots resolve exact browser node IDs; they do not mark DOM
elements with reference attributes. A short-lived JavaScript slot transfers the
node into a Playwright handle and is removed immediately. This is not a stealth
mechanism. Treat webpage text, including social posts, as untrusted data rather
than agent instructions.

## Reporting a vulnerability

Please open a private GitHub security advisory for the repository rather than a
public issue. Include the affected version, reproduction steps, and likely
impact. Do not include real credentials or session material.
