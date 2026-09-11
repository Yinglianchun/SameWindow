import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// Runs against a disposable Chrome profile and controller, never the shared one.
const require = createRequire(process.env.SAMEWINDOW_TEST_PACKAGE || new URL("../package.json", import.meta.url));
const { chromium } = require("playwright-core");
const directory = await mkdtemp(join(tmpdir(), "samewindow-node-refs-"));
const fixture = `<!doctype html><title>SameWindow node identity check</title>
<style>button,input {margin:8px} #pointer {cursor:pointer} #hidden{display:none}</style>
<article><h1>Node identity check</h1><p>Initial article text</p></article>
<span id="account-label">Account name</span><input id="account" aria-labelledby="account-label">
<input id="password" type="password" hidden value="NOT_IN_SNAPSHOT">
<button id="left" onclick="window.lastClick='left'">Save</button>
<button id="right" onclick="window.lastClick='right'">Save</button>
<button id="replace" onclick="window.replacementClicked=true">Replace target</button>
<button id="disabled" disabled>Disabled</button>
<button id="hidden">Hidden</button>
<button id="comment" onclick="document.querySelector('article').insertAdjacentHTML('beforeend','<p>NEW_COMMENT_NODE_CHECK</p>')">Add comment</button>
<button id="dom-only" aria-hidden="true" onclick="window.domClicked=true">DOM fallback</button>
<div id="pointer" onclick="window.pointerClicked=true">Pointer-only widget</div>
<div id="shadow"></div>
<script>
const shadow = document.querySelector('#shadow').attachShadow({mode:'open'});
shadow.innerHTML='<button onclick="window.shadowClicked=true">Shadow button</button>';
window.snapshotMutations=[];
new MutationObserver(records=>window.snapshotMutations.push(...records.map(r=>({type:r.type,name:r.attributeName}))))
 .observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
</script>`;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(request.url === "/article" ? `<!doctype html><title>Article check</title>
    <article><h1>Article check</h1><p>Initial article text</p></article>
    <button id="comment" onclick="document.querySelector('article').insertAdjacentHTML('beforeend','<p>NEW_COMMENT_NODE_CHECK</p>')">Add comment</button>
    <script>window.snapshotMutations=[];new MutationObserver(records=>window.snapshotMutations.push(...records.map(r=>r.type))).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});</script>` : fixture);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
async function unusedPort() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
const cdpPort = await unusedPort();
const controlPort = await unusedPort();
const controllerUrl = `http://127.0.0.1:${controlPort}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let context, controller, logs = "";
async function api(path, body, ok = true) {
  const response = await fetch(controllerUrl + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.ok, ok, JSON.stringify(result));
  return result;
}
async function until(fn, timeoutMs = 22000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn().catch(() => null);
    if (result) return result;
    await pause(300);
  }
  throw new Error("Timed out: " + logs.slice(-1500));
}
try {
  context = await chromium.launchPersistentContext(join(directory, "chrome"), {
    ...(process.env.SAMEWINDOW_TEST_CHROME ? { executablePath: process.env.SAMEWINDOW_TEST_CHROME } : { channel: "chrome" }),
    headless: true, viewport: { width: 1000, height: 800 },
    args: ["--no-sandbox", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${cdpPort}`],
  });
  const page = context.pages()[0];
  await page.goto(fixtureUrl);
  const source = await readFile(new URL("../src/control-server.mjs", import.meta.url), "utf8");
  const controllerFile = join(directory, "cursor-channel.mjs");
  await copyFile(new URL("../src/social-read.mjs", import.meta.url), join(directory, "social-read.mjs"));
  await writeFile(controllerFile, source.replace('import { chromium } from "playwright-core";', `import playwright from ${JSON.stringify(pathToFileURL(require.resolve("playwright-core")).href)}; const { chromium } = playwright;`));
  controller = spawn(process.execPath, [controllerFile], {
    env: { ...process.env, SAMEWINDOW_CONTROL_PORT: String(controlPort),
      SAMEWINDOW_CDP_URL: `http://127.0.0.1:${cdpPort}`,
      SAMEWINDOW_CURSOR_COORDINATE_MODE: "page", SAMEWINDOW_CURSOR_STATE_FILE: join(directory, "cursor.json") },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  controller.stdout.on("data", value => { logs += value; });
  controller.stderr.on("data", value => { logs += value; });
  await until(async () => (await api("/browser/status")).connected, 10000);
  const snapshot = async (options = {}) => (await api("/browser/snapshot", options)).snapshot;
  let snap = await snapshot();
  const byId = id => snap.elements.find(element => element.id === id);
  assert.equal(byId("account").name, "Account name");
  assert.equal(byId("account").source, "accessibility");
  assert.equal(byId("dom-only").source, "dom");
  assert.equal(byId("hidden"), undefined);
  assert.equal(byId("pointer"), undefined);
  assert.equal(JSON.stringify(snap).includes("NOT_IN_SNAPSHOT"), false);
  assert.deepEqual(await page.evaluate(() => window.snapshotMutations), []);
  console.log(`PASS: AX names, DOM fallback, hidden/password exclusion, no snapshot DOM writes (${snap.timingMs} ms)`);
  const act = async (path, element, extra = {}, ok = true) => api(path, { tabRef: snap.tabRef, ref: element.ref, ...extra }, ok);
  const oldRight = byId("right");
  await act("/browser/click", oldRight);
  assert.equal(await page.evaluate(() => window.lastClick), "right");
  await act("/browser/type", byId("account"), { text: "Example user" });
  assert.equal(await page.locator("#account").inputValue(), "Example user");
  await act("/browser/click", byId("dom-only"));
  assert.equal(await page.evaluate(() => window.domClicked), true);
  await act("/browser/click", snap.elements.find(e => e.name === "Shadow button"));
  assert.equal(await page.evaluate(() => window.shadowClicked), true);
  assert.equal(await page.evaluate(() => Object.keys(window).some(key => key.startsWith("__samewindowNodeTransfer_"))), false);
  assert.equal(await page.locator("[data-samewindow-snapshot-ref]").count(), 0);
  console.log("PASS: duplicate labels retain node identity; typing, DOM fallback and shadow clicks use Playwright");
  const replacement = byId("replace");
  await page.evaluate(() => { const old = document.querySelector("#replace"); old.replaceWith(old.cloneNode(true)); });
  const stale = await act("/browser/click", replacement, {}, false);
  assert.match(JSON.stringify(stale), /stale/);
  assert.equal(await page.evaluate(() => window.replacementClicked), undefined);
  await act("/browser/click", byId("disabled"), {}, false);
  await page.evaluate(() => {
    const rect = document.querySelector("#right").getBoundingClientRect();
    const cover = document.createElement("div"); cover.id = "cover";
    Object.assign(cover.style, {position:"fixed",left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`,zIndex:9999});
    document.body.append(cover);
  });
  const covered = await act("/browser/click", oldRight, {}, false);
  assert.match(JSON.stringify(covered), /obstructed/);
  await page.locator("#cover").evaluate(el => el.remove());
  snap = await snapshot({ includePointerExtras: true });
  assert.ok(byId("pointer"));
  await act("/browser/click", oldRight, {}, false);
  await act("/browser/click", byId("pointer"));
  assert.equal(await page.evaluate(() => window.pointerClicked), true);
  await api("/browser/click", { tabRef: snap.tabRef, selector: "#left" }, false);
  assert.equal(await page.evaluate(() => window.lastClick), "right");
  const beforeNavigation = byId("right");
  await page.reload();
  await act("/browser/click", beforeNavigation, {}, false);
  assert.equal(await page.evaluate(() => window.lastClick), undefined);
  console.log("PASS: stale replacement/snapshot/navigation rejected, disabled/obstructed checks and arbitrary selectors rejected");
  await page.locator("#password").evaluate(el => { el.hidden = false; });
  const sensitive = await api("/browser/snapshot", {}, false);
  assert.match(sensitive.error, /sensitive_form/);
  await page.locator("#password").evaluate(el => { el.hidden = true; });
  await page.locator("#shadow").evaluate(el => { el.shadowRoot.innerHTML = '<input type="password" value="SHADOW_SECRET">'; });
  assert.match((await api("/browser/snapshot", {}, false)).error, /sensitive_form/);
  console.log("PASS: visible sensitive inputs, including shadow roots, block snapshots");
  await page.goto(fixtureUrl + "/article");
  await api("/browser/watch", { enabled: true });
  const initial = await until(async () => (await api("/browser/events")).events.find(e => e.type === "page_text"));
  assert.match(initial.text, /Initial article text/);
  await page.evaluate(() => { window.snapshotMutations = []; });
  snap = await snapshot();
  assert.deepEqual(await page.evaluate(() => window.snapshotMutations), []);
  await act("/browser/click", byId("comment"));
  const updated = await until(async () => (await api("/browser/events")).events.find(e => e.type === "page_text" && e.text.includes("NEW_COMMENT_NODE_CHECK")));
  assert.notEqual(updated.textHash, initial.textHash);
  await api("/browser/watch", { enabled: false });
  assert.equal(await page.evaluate(() => typeof globalThis.__samewindowWatchCleanup), "undefined");
  console.log("PASS: co-browsing still delivers initial and changed page text with AX snapshots and clicks");
} finally {
  if (controller && controller.exitCode === null) {
    const stopped = new Promise(resolve => controller.once("exit", resolve)); controller.kill(); await stopped;
  }
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  assert.ok(directory.startsWith(join(tmpdir(), "samewindow-node-refs-")));
  await rm(directory, { recursive: true, force: true });
}
