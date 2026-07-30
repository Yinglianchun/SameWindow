# SameWindow split deployment — browser-side container.
# Runs the *viewer half* of SameWindow (Xvfb + Chromium + VNC + noVNC + control
# server) on the machine next to the human, while the agent stays on a remote
# server and reaches back in through an SSH reverse tunnel.
#
# debian + chromium: native arm64 packages (Apple Silicon), google-chrome has
# no linux/arm64 build.
#
# Build context is the repository root:  docker compose -f split-deployment/...
# (the provided docker-compose.yml sets this up for you)
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb openbox x11vnc websockify novnc tini \
    fonts-noto-cjk fonts-noto-color-emoji ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# node 20 for the control server (debian ships 18)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/samewindow
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/control-server.mjs ./
COPY split-deployment/start-desktop.sh ./
RUN chmod +x start-desktop.sh

# Assemble the noVNC web root exactly like the upstream installer does:
# system noVNC + SameWindow viewer shell + cursor overlay + telemetry patch.
COPY web/novnc/ /opt/web-novnc-src/
RUN mkdir -p /opt/novnc-web \
  && cp -a /usr/share/novnc/. /opt/novnc-web/ \
  && cp /opt/web-novnc-src/samewindow.html \
        /opt/web-novnc-src/agent-cursor.js \
        /opt/web-novnc-src/user-cursor.js \
        /opt/web-novnc-src/watch-mode.js \
        /opt/novnc-web/ \
  && node /opt/web-novnc-src/patch-novnc.mjs /opt/novnc-web/vnc.html

ENV SAMEWINDOW_DISPLAY=:99 \
    SAMEWINDOW_SCREEN=1440x900x24 \
    SAMEWINDOW_CDP_PORT=9222 \
    SAMEWINDOW_CONTROL_PORT=6081 \
    SAMEWINDOW_CONTROL_HOST=0.0.0.0 \
    SAMEWINDOW_CURSOR_STATE_FILE=/opt/novnc-web/cursor-state.json

EXPOSE 6080 6081
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/samewindow/start-desktop.sh"]
