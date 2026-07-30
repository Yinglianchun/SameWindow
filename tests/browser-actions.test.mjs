import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw lastError || new Error(`service did not start: ${url}`);
}

function chromeExecutable() {
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find(existsSync) || "";
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

async function post(baseUrl, pathname, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

function element(snapshot, name) {
  const match = snapshot.elements.find((item) => item.name === name);
  assert.ok(match, `missing element named ${name}`);
  return match;
}

test("snapshot-scoped refs stay bound across refreshes, concurrency, and tabs", {
  timeout: 30000,
  skip: chromeExecutable() ? false : "Chrome or Chromium is required for browser integration coverage",
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "samewindow-browser-actions-"));
  const cdpPort = await freePort();
  const controlPort = await freePort();
  const fixturePort = await freePort();
  const fixture = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/a") {
      response.end(`<!doctype html>
        <button id="increment" onclick="count.textContent = Number(count.textContent) + 1">Increment</button>
        <span>Count: <strong id="count">0</strong></span>`);
      return;
    }
    response.end(`<!doctype html>
      <label>Message <input id="message" aria-label="Message"></label>`);
  });
  fixture.listen(fixturePort, "127.0.0.1");
  await once(fixture, "listening");

  const chrome = spawn(chromeExecutable(), [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${path.join(temporary, "chrome-profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--no-sandbox",
    "about:blank",
  ], { stdio: "ignore" });
  let control;
  try {
    await waitFor(`http://127.0.0.1:${cdpPort}/json/version`);
    control = spawn(process.execPath, [path.join(root, "src", "control-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        SAMEWINDOW_CDP_URL: `http://127.0.0.1:${cdpPort}`,
        SAMEWINDOW_CONTROL_PORT: String(controlPort),
        SAMEWINDOW_CURSOR_COORDINATE_MODE: "page",
        SAMEWINDOW_CURSOR_STATE_FILE: path.join(temporary, "cursor-state.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let controlStderr = "";
    control.stderr.on("data", (chunk) => { controlStderr += chunk; });
    const baseUrl = `http://127.0.0.1:${controlPort}`;
    await waitFor(`${baseUrl}/health`);

    const openedA = await post(baseUrl, "/browser/open", {
      url: `http://127.0.0.1:${fixturePort}/a`,
      newTab: true,
    });
    const openedB = await post(baseUrl, "/browser/open", {
      url: `http://127.0.0.1:${fixturePort}/b`,
      newTab: true,
    });
    const tabA = openedA.body.tab.ref;
    const tabB = openedB.body.tab.ref;

    const first = (await post(baseUrl, "/browser/snapshot", { tabRef: tabA })).body.snapshot;
    const firstRef = element(first, "Increment").ref;
    assert.match(firstRef, new RegExp(`^${first.snapshotId}:e\\d+$`));

    const second = (await post(baseUrl, "/browser/snapshot", { tabRef: tabA })).body.snapshot;
    const secondRef = element(second, "Increment").ref;
    assert.notEqual(secondRef, firstRef);
    const stale = await post(baseUrl, "/browser/click", { tabRef: tabA, ref: firstRef });
    assert.equal(stale.status, 400);
    assert.match(stale.body.error, /stale; take a fresh snapshot/);

    const concurrent = await Promise.all([
      post(baseUrl, "/browser/snapshot", { tabRef: tabA }),
      post(baseUrl, "/browser/snapshot", { tabRef: tabA }),
    ]);
    const concurrentRefs = concurrent.map(({ body }) => element(body.snapshot, "Increment").ref);
    assert.notEqual(concurrentRefs[0], concurrentRefs[1]);
    const concurrentActions = await Promise.all(
      concurrentRefs.map((ref) => post(baseUrl, "/browser/click", { tabRef: tabA, ref })),
    );
    assert.deepEqual(concurrentActions.map(({ status }) => status).sort(), [200, 400]);

    const latestA = (await post(baseUrl, "/browser/snapshot", { tabRef: tabA })).body.snapshot;
    const latestARef = element(latestA, "Increment").ref;
    const latestB = (await post(baseUrl, "/browser/snapshot", { tabRef: tabB })).body.snapshot;
    const latestBRef = element(latestB, "Message").ref;

    const clicked = await post(baseUrl, "/browser/click", { tabRef: tabA, ref: latestARef });
    assert.equal(clicked.status, 200);
    assert.equal(clicked.body.result.ref, latestARef);
    const typed = await post(baseUrl, "/browser/type", {
      tabRef: tabB,
      ref: latestBRef,
      text: "same window",
    });
    assert.equal(typed.status, 200);
    assert.equal(typed.body.result.ref, latestBRef);

    const afterClick = (await post(baseUrl, "/browser/snapshot", { tabRef: tabA })).body.snapshot;
    assert.match(afterClick.visibleText, /Count:\s*2/);
    const afterType = (await post(baseUrl, "/browser/snapshot", { tabRef: tabB })).body.snapshot;
    assert.equal(element(afterType, "Message").value, "same window");
    assert.equal(controlStderr, "");
  } finally {
    await stopProcess(control);
    await stopProcess(chrome);
    fixture.close();
    await once(fixture, "close");
    await rm(temporary, { recursive: true, force: true });
  }
});
