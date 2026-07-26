import { execFile } from "node:child_process";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const host = process.env.SAMEWINDOW_LIFECYCLE_HOST || "127.0.0.1";
const port = Number(process.env.SAMEWINDOW_LIFECYCLE_PORT || 6082);
const dashboardPath = process.env.SAMEWINDOW_DASHBOARD_PATH
  || "/opt/samewindow/web/dashboard.html";
const viewerUrl = process.env.SAMEWINDOW_VIEWER_URL
  || "http://127.0.0.1:6080/samewindow.html";
const profilePath = process.env.SAMEWINDOW_PROFILE_PATH
  || "/var/lib/samewindow/chrome-profile";
const controlUrl = process.env.SAMEWINDOW_CONTROL_URL
  || "http://127.0.0.1:6081";
const sleepingFoxPath = process.env.SAMEWINDOW_SLEEPING_FOX_PATH
  || new URL("../web/sleeping-fox.svg", import.meta.url);

const startOrder = [
  "samewindow-xvfb.service",
  "samewindow-openbox.service",
  "samewindow-chrome.service",
  "samewindow-x11vnc.service",
  "samewindow-novnc.service",
  "samewindow-control.service",
];
const stopOrder = [...startOrder].reverse();

let activeOperation = null;
let lastTransition = null;
const dashboardHtml = await readFile(dashboardPath, "utf8");
const sleepingFoxSvg = await readFile(sleepingFoxPath);

function sendJson(response, status, value) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.writeHead(status);
  response.end(`${JSON.stringify(value)}\n`);
}

function sendDashboard(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "frame-src http://127.0.0.1:6080 http://localhost:6080",
    "connect-src 'self'",
  ].join("; "));
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.writeHead(200);
  response.end(dashboardHtml);
}

function sendSleepingFox(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.writeHead(200);
  response.end(sleepingFoxSvg);
}

function readJsonBody(request, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

async function unitState(unit) {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["show", unit, "--property=ActiveState", "--property=SubState", "--property=MainPID"],
      { timeout: 4000 },
    );
    const properties = Object.fromEntries(
      stdout.trim().split(/\r?\n/).map((line) => {
        const separator = line.indexOf("=");
        return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    return {
      unit,
      activeState: properties.ActiveState || "unknown",
      subState: properties.SubState || "unknown",
      mainPid: Number(properties.MainPID) || null,
    };
  } catch (error) {
    return { unit, activeState: "unknown", subState: "unknown", mainPid: null, error: error.message };
  }
}

async function endpointReady(url, timeoutMs = 900) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

async function lifecycleStatus() {
  const services = await Promise.all(startOrder.map(unitState));
  const byName = Object.fromEntries(services.map((service) => [service.unit, service]));
  const running = startOrder.every((unit) => byName[unit]?.activeState === "active");
  const ready = running && await Promise.all([
    endpointReady("http://127.0.0.1:6080/samewindow.html"),
    endpointReady(`${controlUrl}/health`),
  ]).then((states) => states.every(Boolean));
  return {
    ok: true,
    phase: activeOperation || (ready ? "running" : running ? "starting" : "stopped"),
    ready,
    viewerUrl,
    profile: { persistent: true, path: profilePath },
    services,
    lastTransition,
  };
}

async function waitUntil(predicate, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startBrowser() {
  if (activeOperation) throw new Error(`lifecycle operation already running: ${activeOperation}`);
  activeOperation = "starting";
  try {
    for (const unit of startOrder) {
      await execFileAsync("systemctl", ["start", unit], { timeout: 20000 });
    }
    const ready = await waitUntil(async () => (
      await endpointReady("http://127.0.0.1:6080/samewindow.html", 700)
      && await endpointReady(`${controlUrl}/health`, 700)
    ));
    if (!ready) throw new Error("shared browser did not become ready before the timeout");
    lastTransition = { action: "start", at: new Date().toISOString() };
  } finally {
    activeOperation = null;
  }
  return lifecycleStatus();
}

async function stopBrowser() {
  if (activeOperation) throw new Error(`lifecycle operation already running: ${activeOperation}`);
  activeOperation = "stopping";
  let watchDisabled = false;
  try {
    try {
      const response = await fetch(`${controlUrl}/browser/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
        signal: AbortSignal.timeout(1500),
      });
      watchDisabled = response.ok;
    } catch {
      watchDisabled = false;
    }
    for (const unit of stopOrder) {
      await execFileAsync("systemctl", ["stop", unit], { timeout: 20000 }).catch(() => {});
    }
    await waitUntil(async () => {
      const states = await Promise.all(startOrder.map(unitState));
      return states.every((state) => state.activeState !== "active");
    }, 20000);
    lastTransition = { action: "stop", at: new Date().toISOString(), watchDisabled };
  } finally {
    activeOperation = null;
  }
  return lifecycleStatus();
}

function lifecyclePostAllowed(request) {
  return request.headers["x-samewindow-lifecycle"] === "1";
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);
  try {
    if (request.method === "GET" && requestUrl.pathname === "/") {
      sendDashboard(response);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/sleeping-fox.svg") {
      sendSleepingFox(response);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "samewindow-lifecycle" });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/status") {
      sendJson(response, 200, await lifecycleStatus());
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/start") {
      if (!lifecyclePostAllowed(request)) {
        sendJson(response, 403, { ok: false, error: "missing lifecycle header" });
        return;
      }
      await readJsonBody(request);
      sendJson(response, 200, await startBrowser());
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/stop") {
      if (!lifecyclePostAllowed(request)) {
        sendJson(response, 403, { ok: false, error: "missing lifecycle header" });
        return;
      }
      await readJsonBody(request);
      sendJson(response, 200, await stopBrowser());
      return;
    }
    sendJson(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: String(error?.message || error).slice(0, 500) });
  }
});

server.listen(port, host, () => {
  console.log(`SameWindow lifecycle listening on http://${host}:${port}`);
});
