import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createTaskController } from "../src/task-controller.mjs";

test("tasks off or missing credentials do not access the browser", async () => {
  const previousMode = process.env.SAMEWINDOW_TASK_MODE, previousKey = process.env.SAMEWINDOW_JEV_API_KEY;
  const controller = createTaskController({ page() { throw new Error("browser must not be touched"); } });
  try {
    process.env.SAMEWINDOW_TASK_MODE = "off";
    assert.equal((await controller.run({}, new AbortController().signal)).stopReason, "task_off");
    process.env.SAMEWINDOW_TASK_MODE = "bounded";
    delete process.env.SAMEWINDOW_JEV_API_KEY;
    assert.equal((await controller.run({}, new AbortController().signal)).stopReason, "missing_jev_key");
  } finally {
    if (previousMode === undefined) delete process.env.SAMEWINDOW_TASK_MODE; else process.env.SAMEWINDOW_TASK_MODE = previousMode;
    if (previousKey === undefined) delete process.env.SAMEWINDOW_JEV_API_KEY; else process.env.SAMEWINDOW_JEV_API_KEY = previousKey;
  }
});

const chromePath = [process.env.SAMEWINDOW_TEST_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(p => p && existsSync(p));
async function freePort() {
  const server = http.createServer(); await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}

test("task endpoint uses safe DOM refs, isolates account results and stops on takeover", {
  timeout: 60000, skip: chromePath ? false : "Chrome required for browser integration",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "samewindow-task-"));
  const cdpPort = await freePort(), controlPort = await freePort();
  let context, child, logs = "", scenario = "no_pin";
  async function api(path, body) {
    const response = await fetch(`http://127.0.0.1:${controlPort}${path}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  try {
    context = await chromium.launchPersistentContext(join(directory, "chrome"), {
      executablePath: chromePath, headless: true, viewport: { width: 1000, height: 800 },
      args: [`--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", "--no-sandbox"],
    });
    const page = context.pages()[0];
    await page.route("https://x.com/**", async route => {
      const u = new URL(route.request().url());
      const article = `<article data-testid="tweet"><span data-testid="User-Name">Rain @rain</span>${scenario === "pin" ? '<span data-testid="socialContext">Pinned</span>' : ''}<a href="/rain/status/123"><time>today</time></a><div data-testid="tweetText">Fixture post body</div></article>`;
      const search = `<input role="combobox" aria-label="Search query" value="${u.searchParams.get('q') || ''}" onkeydown="if(event.key==='Enter')location.href='/search?q='+encodeURIComponent(this.value)+'&src=typed_query'">`;
      let body;
      if (u.pathname === "/i/flow/login" || scenario === "sensitive_form") body = '<input type="password" value="NEVER_SEND_TO_PROVIDER">';
      else if (u.pathname === "/home") body = '<a aria-label="Search and explore" href="/explore">Search and explore</a>';
      else if (u.pathname === "/explore") body = search;
      else if (u.pathname === "/search") body = search + '<a role="tab" href="#">Top</a><a role="tab" href="/search?q=Rain&src=typed_query&f=user">People</a>' + (u.searchParams.get("f") === "user" ? '<div data-testid="UserCell"><a href="/rain">Rain</a></div>' + (scenario === "ambiguous" ? '<div data-testid="UserCell"><a href="/rain2">Rain</a></div>' : '') : article);
      else body = '<div data-testid="UserName">Rain<br>@rain</div>' + article;
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<html><meta charset="utf-8"><title>Task fixture</title><main><div data-testid="primaryColumn">${body}</div><aside><div data-testid="UserCell"><a href="/sidebar">Rain</a></div></aside></main></html>` });
    });
    await page.goto("https://x.com/home");
    for (const file of ["social-read.mjs", "browser-reflex.mjs", "browser-tasks.mjs", "task-controller.mjs"]) await copyFile(new URL(`../src/${file}`, import.meta.url), join(directory, file));
    const provider = await readFile(join(directory, "browser-reflex.mjs"), "utf8");
    await writeFile(join(directory, "browser-reflex.mjs"), provider.replace("decide = jevDecision", "decide = async (_state, candidates) => { await new Promise(r => setTimeout(r, 300)); return { choice: candidates.find(c => c.kind)?.id || 'HANDOFF', model: 'offline-mock' }; }"));
    const require = createRequire(import.meta.url);
    const source = await readFile(new URL("../src/control-server.mjs", import.meta.url), "utf8");
    await writeFile(join(directory, "control-server.mjs"), source.replace('import { chromium } from "playwright-core";', `import playwright from ${JSON.stringify(pathToFileURL(require.resolve("playwright-core")).href)}; const { chromium } = playwright;`));
    child = spawn(process.execPath, [join(directory, "control-server.mjs")], {
      env: { ...process.env, SAMEWINDOW_CONTROL_PORT: String(controlPort), SAMEWINDOW_CDP_URL: `http://127.0.0.1:${cdpPort}`,
        SAMEWINDOW_TASK_MODE: "bounded", SAMEWINDOW_JEV_API_KEY: "offline-fixture", SAMEWINDOW_ALLOW_SENSITIVE_AUTOMATION: "0",
        SAMEWINDOW_CURSOR_COORDINATE_MODE: "page", SAMEWINDOW_CURSOR_STATE_FILE: join(directory, "cursor.json") }, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", data => { logs += data; });
    let ready = false;
    for (let i = 0; i < 50; i++) { if (await api("/browser/status").then(r => r.connected).catch(() => false)) { ready = true; break; } await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, logs);
    const tabRef = (await api("/browser/snapshot", {})).snapshot.tabRef;
    const task = operation => api("/browser/task", { operation, text: "Rain", tabRef }).then(r => r.task);
    const searchResult = await task("x_search");
    assert.equal(searchResult.status, "completed", JSON.stringify(searchResult));
    assert.ok(searchResult.snapshot.visibleText.includes("Fixture post body"));
    assert.match(searchResult.snapshot.elements[0].ref, /^s\d+:e\d+$/);
    assert.equal(searchResult.contentSource, "browser_dom");
    const noPin = await task("x_profile_pinned");
    assert.equal(noPin.status, "completed", JSON.stringify(noPin) + logs);
    assert.equal(noPin.phases.profile.evidence.result, "no_pinned_post_visible_at_profile_top");
    scenario = "pin";
    const pin = await task("x_profile_pinned");
    assert.equal(pin.status, "completed", JSON.stringify(pin));
    assert.equal(pin.phases.profile.evidence.pinnedUrl, "https://x.com/rain/status/123");
    scenario = "ambiguous";
    assert.equal((await task("x_profile_pinned")).stopReason, "ambiguous_nickname");
    await page.goto("https://x.com/i/flow/login");
    const sensitive = await task("x_search");
    assert.match(sensitive.stopReason, /sensitive page/);
    assert.equal(sensitive.snapshot, null);
    assert.ok(!JSON.stringify(sensitive).includes("NEVER_SEND_TO_PROVIDER"));
    scenario = "sensitive_form"; await page.goto("https://x.com/home");
    assert.match((await task("x_search")).stopReason, /sensitive_form/);
    scenario = "no_pin"; await page.goto("https://x.com/home");
    const inFlight = task("x_search");
    await new Promise(r => setTimeout(r, 180));
    await api("/browser/geometry");
    await api("/browser/observed-tab", { title: await page.title(), address: page.url() });
    await api("/user-cursor", { inside: false, x: 1, y: 1, buttons: 1, pointerType: "mouse" });
    await api("/user-cursor", { inside: false, x: 1, y: 1, buttons: 0, pointerType: "mouse" });
    assert.equal((await inFlight).status, "completed");
    await page.goto("https://x.com/home");
    const interruptedTask = task("x_search");
    await new Promise(r => setTimeout(r, 180));
    await api("/user-cursor", { inside: true, x: 0.5, y: 0.5, buttons: 1, pointerType: "mouse" });
    assert.equal((await interruptedTask).stopReason, "external_control_taken");
    assert.equal(page.url(), "https://x.com/home");
    const stale = await api("/browser/task", { operation: "x_search", text: "Rain", tabRef: "tab-999999" });
    assert.match(stale.task.stopReason, /stale/);
  } finally {
    if (child && child.exitCode === null) { const stopped = new Promise(r => child.once("exit", r)); child.kill(); await stopped; }
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
