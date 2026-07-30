import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const splitRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(splitRoot, "..", "..");
const runtimePath = path.join(splitRoot, "runtime");
const profilePath = path.join(splitRoot, "data", "chrome-profile");
const overlayScript = path.join(splitRoot, "native-overlay.ps1");
const controlScript = path.join(repoRoot, "src", "control-server.mjs");
const cursorStateFile = path.join(runtimePath, "samewindow-cursor-state.json");
const settingsPath = path.join(splitRoot, "settings.json");
const lifecycleHost = process.env.SAMEWINDOW_NATIVE_LIFECYCLE_HOST || "127.0.0.1";
const lifecyclePort = Number(process.env.SAMEWINDOW_NATIVE_LIFECYCLE_PORT || 6084);
const controlUrl = "http://127.0.0.1:6081";
const cdpUrl = "http://127.0.0.1:9222";

let chromeProcess = null;
let controlProcess = null;
let overlayProcess = null;
let activeOperation = null;
let desiredRunning = false;
let lastTransition = null;
let overlayRecovery = null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadSettings() {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`invalid settings.json: ${error.message}`);
  }
}

async function findChrome(configuredPath = "") {
  const candidates = [
    configuredPath,
    process.env.SAMEWINDOW_CHROME_BIN,
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
      : "",
    process.env["PROGRAMFILES(X86)"]
      ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")
      : "",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : "",
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe")
      : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error("Chrome or Edge was not found; set chromePath in settings.json");
}

async function endpointReady(url, timeoutMs = 1000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointReady(url)) return true;
    await delay(300);
  }
  return endpointReady(url);
}

function childActive(child) {
  return Boolean(child && child.exitCode === null && !child.killed);
}

function attachChild(name, child) {
  child.on("error", (error) => {
    console.error(`[native-browser] ${name} failed:`, error);
  });
  child.on("exit", (code, signal) => {
    console.log(`[native-browser] ${name} exited code=${code} signal=${signal}`);
    if (name === "chrome" && chromeProcess === child) chromeProcess = null;
    if (name === "control" && controlProcess === child) controlProcess = null;
    if (name === "overlay" && overlayProcess === child) overlayProcess = null;
  });
}

async function startControl() {
  if (childActive(controlProcess) && await endpointReady(`${controlUrl}/health`)) return;
  const environment = {
    ...process.env,
    SAMEWINDOW_CONTROL_HOST: "127.0.0.1",
    SAMEWINDOW_CONTROL_PORT: "6081",
    SAMEWINDOW_CDP_URL: cdpUrl,
    SAMEWINDOW_CURSOR_COORDINATE_MODE: "page",
    SAMEWINDOW_CURSOR_STATE_FILE: cursorStateFile,
  };
  controlProcess = spawn(process.execPath, [controlScript], {
    cwd: path.dirname(controlScript),
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  attachChild("control", controlProcess);
  if (!await waitFor(`${controlUrl}/health`, 12000)) {
    throw new Error("local browser control did not become ready");
  }
  if (!await waitFor(`${controlUrl}/browser/status`, 8000)) {
    throw new Error("local browser control could not attach to the dedicated Chrome window");
  }
}

async function tcpReady(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ready) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForTcp(host, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpReady(host, port)) return true;
    await delay(250);
  }
  return tcpReady(host, port);
}

async function startOverlay() {
  if (childActive(overlayProcess)) return;
  const powershellPath = path.join(
    process.env.SYSTEMROOT || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const argumentsList = [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    overlayScript,
    "-ProfilePath",
    profilePath,
    "-ControlUrl",
    controlUrl,
    "-CursorStateFile",
    cursorStateFile,
  ];
  if (childActive(chromeProcess) && chromeProcess.pid) {
    argumentsList.push("-ChromePid", String(chromeProcess.pid));
  }
  overlayProcess = spawn(powershellPath, argumentsList, {
    cwd: splitRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  attachChild("overlay", overlayProcess);
}

async function startChrome() {
  if (await endpointReady(`${cdpUrl}/json/version`)) return;
  const settings = await loadSettings();
  const chromePath = await findChrome(settings.chromePath);
  const width = Math.max(720, Number(settings.windowWidth) || 1280);
  const height = Math.max(540, Number(settings.windowHeight) || 820);
  const privacyExit = String(settings.privacyExit || "vps").trim().toLowerCase();
  const socksPort = Math.max(1, Math.min(65535, Number(settings.socksPort) || 1080));
  const configuredProxy = String(settings.proxyServer || "").trim();
  const proxyServer = configuredProxy || (
    privacyExit === "vps" ? `socks5://localhost:${socksPort}` : ""
  );
  if (privacyExit === "vps" && !configuredProxy && !await waitForTcp("127.0.0.1", socksPort)) {
    throw new Error(
      `the VPS privacy SOCKS is not ready on 127.0.0.1:${socksPort}; start tunnel.ps1 first`,
    );
  }
  const argumentsList = [
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=9222`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
    // Match the user's daily Chrome on networks where UDP/443 stalls before
    // Chromium falls back from QUIC to HTTP/2.
    "--disable-quic",
    "--new-window",
    `--window-size=${width},${height}`,
  ];
  if (proxyServer) {
    argumentsList.push(`--proxy-server=${proxyServer}`);
  }
  argumentsList.push(String(settings.homeUrl || "https://www.google.com/"));

  chromeProcess = spawn(chromePath, argumentsList, {
    cwd: splitRoot,
    stdio: "ignore",
    windowsHide: false,
  });
  attachChild("chrome", chromeProcess);
  if (!await waitFor(`${cdpUrl}/json/version`, 20000)) {
    throw new Error("the dedicated Chrome window did not expose CDP on 127.0.0.1:9222");
  }
}

async function terminate(child, timeoutMs = 4000) {
  if (!childActive(child)) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, delay(timeoutMs)]);
}

async function disableTogetherBrowse() {
  try {
    const response = await fetch(`${controlUrl}/browser/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function lifecycleStatus() {
  const [cdpReady, controlReady] = await Promise.all([
    endpointReady(`${cdpUrl}/json/version`),
    endpointReady(`${controlUrl}/health`),
  ]);
  const overlayReady = childActive(overlayProcess);
  let state = !desiredRunning && !cdpReady && !controlReady && !overlayReady
    ? "stopped"
    : desiredRunning && cdpReady && controlReady && overlayReady
      ? "running"
      : "degraded";
  if (activeOperation === "start") state = "starting";
  if (activeOperation === "stop") state = "stopping";
  return {
    ok: true,
    deploymentMode: "split-local-windows",
    state,
    operation: activeOperation,
    viewer: {
      kind: "native-window",
      ready: cdpReady && overlayReady,
      label: "SameWindow Chrome",
    },
    controlReady,
    processes: {
      chrome: cdpReady ? "active" : "inactive",
      control: controlReady ? "active" : "inactive",
      overlay: overlayReady ? "active" : "inactive",
      lifecycle: "active",
    },
    profile: {
      preserved: true,
      path: profilePath,
      storage: "local-windows-directory",
    },
    lastTransition,
  };
}

async function startBrowserGroup() {
  if (activeOperation) throw new Error(`lifecycle operation already running: ${activeOperation}`);
  activeOperation = "start";
  desiredRunning = true;
  try {
    await mkdir(runtimePath, { recursive: true });
    await mkdir(profilePath, { recursive: true });
    if (!await exists(cursorStateFile)) {
      await writeFile(cursorStateFile, '{"sequence":0,"visible":false}\n', "utf8");
    }
    await startChrome();
    await startControl();
    await startOverlay();
    lastTransition = {
      action: "start",
      at: new Date().toISOString(),
      source: "native-lifecycle",
    };
  } finally {
    activeOperation = null;
  }
  return lifecycleStatus();
}

async function stopBrowserGroup() {
  if (activeOperation) throw new Error(`lifecycle operation already running: ${activeOperation}`);
  activeOperation = "stop";
  desiredRunning = false;
  try {
    const togetherBrowseDisabled = await disableTogetherBrowse();
    try {
      await fetch(`${controlUrl}/browser/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Fall back to the exact child process when CDP is already unavailable.
    }
    await terminate(controlProcess);
    await terminate(overlayProcess);
    await terminate(chromeProcess);
    controlProcess = null;
    overlayProcess = null;
    chromeProcess = null;
    lastTransition = {
      action: "stop",
      at: new Date().toISOString(),
      source: "native-lifecycle",
      togetherBrowseDisabled,
    };
  } finally {
    activeOperation = null;
  }
  return lifecycleStatus();
}

function sendJson(response, status, value) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.writeHead(status);
  response.end(`${JSON.stringify(value)}\n`);
}

function postAllowed(request) {
  return request.headers["x-samewindow-lifecycle"] === "1";
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${lifecycleHost}:${lifecyclePort}`);
  try {
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "samewindow-native-lifecycle" });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/status") {
      sendJson(response, 200, await lifecycleStatus());
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/start") {
      if (!postAllowed(request)) {
        sendJson(response, 403, { ok: false, error: "lifecycle header required" });
        return;
      }
      sendJson(response, 200, await startBrowserGroup());
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/stop") {
      if (!postAllowed(request)) {
        sendJson(response, 403, { ok: false, error: "lifecycle header required" });
        return;
      }
      sendJson(response, 200, await stopBrowserGroup());
      return;
    }
    sendJson(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: String(error?.message || error).slice(0, 500) });
  }
});

async function shutdown() {
  desiredRunning = false;
  await terminate(controlProcess, 1500);
  await terminate(overlayProcess, 1500);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await mkdir(runtimePath, { recursive: true });
server.listen(lifecyclePort, lifecycleHost, () => {
  console.log(`SameWindow native browser lifecycle listening on http://${lifecycleHost}:${lifecyclePort}`);
});

setInterval(() => {
  if (!desiredRunning || activeOperation || childActive(overlayProcess) || overlayRecovery) return;
  overlayRecovery = startOverlay()
    .catch((error) => console.error("[native-browser] overlay recovery failed:", error))
    .finally(() => {
      overlayRecovery = null;
    });
}, 1000).unref();
