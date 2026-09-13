import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { socialUrl } from "../src/social-read.mjs";

// Disposable profile, mocked platform responses, real Chrome / CDP / controller.
// Never opens an account, sends a social write, or touches the real shared profile.
const require = createRequire(process.env.SAMEWINDOW_TEST_PACKAGE || new URL("../package.json", import.meta.url));
const { chromium } = require("playwright-core");
const directory = await mkdtemp(join(tmpdir(), "samewindow-social-read-"));
async function port() {
  const s = http.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
const cdpPort = await port(), controlPort = await port();
let context, controller, logs = "", challenge = false, mismatch = false;
let releaseSlow, slowDetail = false;
const slowResource = new Promise(resolve => { releaseSlow = resolve; });
const visits = [], writes = [];
const noteA = "aaaaaaaaaaaaaaaaaaaaaaaa", noteB = "bbbbbbbbbbbbbbbbbbbbbbbb";
const xTweet = (id, body = `post ${id}`, extra = "") => `<article data-testid="tweet"><div data-testid="User-Name">Example\n@example</div>
  <a href="https://x.com/example/status/${id}"><time datetime="2026-09-11">today</time></a>
  <div data-testid="tweetText">${body}</div><button data-testid="like" onclick="fetch('/forbidden-write',{method:'POST'})">1</button>${extra}</article>`;
const xhsCard = (id, title) => `<section class="note-item">
  <a href="https://www.xiaohongshu.com/explore/${id}" style="display:none"></a>
  <a href="https://www.xiaohongshu.com/explore/${id}" style="visibility:hidden">hidden duplicate</a>
  <a href="https://www.xiaohongshu.com/explore/${id}" style="display:block;width:0;height:0;overflow:hidden"></a>
  <a class="cover" href="https://www.xiaohongshu.com/explore/${id}?xsec_token=KEEP_ME&xsec_source=pc_feed"><img src="https://example.test/cover.png" alt="cover"></a>
  <a class="title" href="https://www.xiaohongshu.com/explore/${id}?xsec_token=KEEP_ME&xsec_source=pc_feed">${title}</a><div class="author"><span class="name">Example</span></div></section>`;
const html = body => `<!doctype html><html><head><title>Social fixture</title><style>article,section{display:block;min-height:150px} .comments-container{height:180px;overflow:auto}</style></head><body>${body}</body></html>`;
async function api(action, payload) {
  const r = await fetch(`http://127.0.0.1:${controlPort}/browser/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  assert.equal(r.status, 200); return r.json();
}
try {
  for (const url of ["https://x.com.evil.test/example/status/1", "https://x.com@evil.test/example/status/1", "http://x.com/example/status/1", "https://x.com:444/example/status/1", "https://www.xiaohongshu.com/explore/not-a-note", "https://xhslink.com/abc"]) {
    assert.throws(() => socialUrl(url), /URL|HTTPS/);
  }
  assert.equal(socialUrl(`https://www.xiaohongshu.com/explore/${noteA}?xsec_token=KEEP_ME`).url.endsWith("xsec_token=KEEP_ME"), true);
  context = await chromium.launchPersistentContext(join(directory, "profile"), {
    channel: "chrome", headless: true, viewport: { width: 1000, height: 800 },
    args: [`--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1"],
  });
  await context.route("**/*", async route => {
    const req = route.request(); const url = new URL(req.url());
    if (req.method() !== "GET") writes.push(req.url());
    if (url.pathname === "/slow.js") {
      await slowResource;
      return route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
    }
    if (req.resourceType() !== "document") return route.fulfill({ status: 204, body: "" });
    visits.push(url.href);
    let body;
    if (url.hostname === "x.com") {
      if (challenge) body = '<div id="captcha">Human verification</div>';
      else if (url.pathname === "/home" || url.pathname === "/search") body = xTweet(100) + xTweet(200, "post 200", '<div data-testid="tweetText">quoted post</div>');
      else body = xTweet(mismatch ? 999 : url.pathname.split("/").at(-1), "EXACT TARGET") + xTweet(300, "visible reply");
    } else if (url.hostname === "www.xiaohongshu.com") {
      if (url.pathname === "/explore" || url.pathname === "/search_result") body = xhsCard(noteA, "Hidden card").replace('class="note-item"', 'class="note-item" style="display:none"') + xhsCard(noteA, "A note") + xhsCard(noteB, "B note");
      else body = `<div class="note-detail-mask"><div id="detail-title">Example note</div><div id="detail-desc">NOTE BODY</div>
        <div class="comments-container"><div class="parent-comment" data-id="c1"><span class="name">SameWindow</span><div class="content">first comment</div>
        <div class="reply-container"><div class="comment-item-sub" data-id="c2"><span class="name">Example</span><div class="content">nested reply</div></div></div></div></div></div>`;
      if (url.pathname.endsWith(noteB)) body = body.replace('<div id="detail-desc">NOTE BODY</div>', '<div class="media-container"><img src="https://example.test/note.png"></div>');
    } else body = "UNRELATED HUMAN TAB";
    if (url.searchParams.get("q") === "slow-resource" || (slowDetail && url.pathname.includes("/status/"))) body += '<script src="/slow.js"></script>';
    await route.fulfill({ status: 200, contentType: "text/html", body: html(body) });
  });
  const human = context.pages()[0]; await human.goto("https://example.test/keep");
  const source = await readFile(new URL("../src/control-server.mjs", import.meta.url), "utf8");
  await copyFile(new URL("../src/social-read.mjs", import.meta.url), join(directory, "social-read.mjs"));
  await writeFile(join(directory, "cursor-channel.mjs"), source.replace('import { chromium } from "playwright-core";',
    `import playwright from ${JSON.stringify(pathToFileURL(require.resolve("playwright-core")).href)}; const { chromium } = playwright;`));
  controller = spawn(process.execPath, [join(directory, "cursor-channel.mjs")], {
    env: { ...process.env, SAMEWINDOW_CONTROL_PORT: String(controlPort), SAMEWINDOW_CDP_URL: `http://127.0.0.1:${cdpPort}`,
      SAMEWINDOW_CURSOR_COORDINATE_MODE: "page", SAMEWINDOW_CURSOR_STATE_FILE: join(directory, "cursor.json") },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  controller.stdout.on("data", d => { logs += d; }); controller.stderr.on("data", d => { logs += d; });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${controlPort}/health`).then(r => r.ok).catch(() => false)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const feed = await api("social/feed", { platform: "x", limit: 2 });
  assert.equal(feed.ok, true, JSON.stringify(feed)); assert.deepEqual(feed.items.map(i => i.id), ["100", "200"]);
  assert.equal(context.pages().length, 2); assert.equal(human.url(), "https://example.test/keep");
  const again = await api("social/feed", { platform: "x", limit: 2 });
  assert.equal(again.tabRef, feed.tabRef); assert.equal(visits.filter(u => u === "https://x.com/home").length, 1);
  const post = await api("social/read", { url: feed.items[1].url, tabRef: feed.tabRef, limit: 1 });
  assert.equal(post.ok, true, JSON.stringify(post)); assert.equal(post.post.id, "200");
  assert.equal(post.post.text, "EXACT TARGET"); assert.equal(post.navigation, "feed_card_click");
  assert.equal(post.returnedToList, true); assert.equal(post.thread[0].id, "300");
  assert.equal(JSON.parse(await readFile(join(directory, "cursor.json"), "utf8")).click, true);
  console.log("PASS X: batch, same-list reuse, exact-card click, thread, back navigation, visible cursor, unrelated tab intact");

  const xhs = await api("social/feed", { platform: "xiaohongshu", limit: 2 });
  assert.equal(xhs.ok, true, JSON.stringify(xhs));
  const note = await api("social/read", { url: xhs.items[0].url, tabRef: xhs.tabRef, limit: 2 });
  assert.equal(note.ok, true, JSON.stringify(note)); assert.equal(note.post.text, "NOTE BODY");
  assert.equal(xhs.items[0].url.includes("xsec_token=KEEP_ME"), true);
  assert.deepEqual(xhs.items[0].images, ["https://example.test/cover.png"]);
  assert.deepEqual(note.comments.map(c => c.text), ["first comment", "nested reply"]);
  assert.equal(note.comments[1].isReply, true); assert.equal(note.returnedToList, true);
  console.log("PASS Xiaohongshu: complete token URL, exact note, nested comments, list restored");

  const xhsPage = context.pages().find(p => p.url() === "https://www.xiaohongshu.com/explore");
  await xhsPage.locator(`section.note-item:visible a.cover[href*="${noteA}"]`).evaluate(el => { el.style.display = "none"; });
  const titleFallback = await api("social/read", { url: xhs.items[0].url, tabRef: xhs.tabRef, limit: 2 });
  assert.equal(titleFallback.ok, true, JSON.stringify(titleFallback));
  assert.equal(titleFallback.post.id, noteA); assert.equal(titleFallback.returnedToList, true);
  await xhsPage.locator(`section.note-item:visible`).filter({ has: xhsPage.locator(`a[href*="${noteB}"]`) }).evaluate(el => { el.style.marginTop = "1800px"; });
  const imageOnly = await api("social/read", { url: xhs.items[1].url, tabRef: xhs.tabRef, limit: 2 });
  assert.equal(imageOnly.ok, true, JSON.stringify(imageOnly)); assert.equal(imageOnly.post.text, "");
  assert.deepEqual(imageOnly.post.images, ["https://example.test/note.png"]);
  assert.equal(imageOnly.post.id, noteB); assert.equal(imageOnly.returnedToList, true);
  await xhsPage.locator(`section.note-item a[href*="${noteA}"]`).evaluateAll(links => links.forEach(el => { el.style.display = "none"; }));
  const hiddenOnly = await api("social/read", { url: xhs.items[0].url, tabRef: xhs.tabRef, limit: 1 });
  assert.equal(hiddenOnly.code, "target_not_found", JSON.stringify(hiddenOnly));
  assert.equal(xhsPage.url(), "https://www.xiaohongshu.com/explore");
  console.log("PASS Xiaohongshu regression: hidden duplicate cards/links, zero-size links, title fallback, offscreen image-only post, and hidden-only target rejection");

  const xpage = context.pages().find(p => p.url() === "https://x.com/home");
  await xpage.locator('article[data-testid="tweet"]').nth(1).evaluate(el => el.remove());
  const missing = await api("social/read", { url: feed.items[1].url, tabRef: feed.tabRef, limit: 1 });
  assert.equal(missing.code, "target_not_found", JSON.stringify(missing)); assert.equal(xpage.url(), "https://x.com/home");
  const stale = await api("social/feed", { platform: "x", tabRef: "tab-does-not-exist" });
  assert.equal(stale.code, "stale_tab");
  await xpage.goto("https://example.test/human-navigated");
  const changed = await api("social/read", { url: feed.items[0].url, tabRef: feed.tabRef });
  assert.equal(changed.code, "list_changed"); assert.equal(xpage.url(), "https://example.test/human-navigated");
  mismatch = true;
  const wrong = await api("social/read", { url: "https://x.com/example/status/444", limit: 1 });
  assert.equal(wrong.code, "target_not_found"); mismatch = false;
  const slow = await api("social/feed", { platform: "x", query: "slow-resource", limit: 2 });
  assert.equal(slow.ok, true, JSON.stringify(slow));
  const slowPage = context.pages().find(p => p.url().includes("slow-resource"));
  assert.equal(await slowPage.evaluate(() => document.readyState), "loading");
  slowDetail = true;
  const slowRead = await api("social/read", { url: slow.items[0].url, tabRef: slow.tabRef, limit: 1 });
  assert.equal(slowRead.ok, true, JSON.stringify(slowRead));
  assert.equal(slowRead.post.text, "EXACT TARGET");
  assert.equal(slowRead.returnedToList, true);
  slowDetail = false;
  releaseSlow();
  console.log("PASS slow resources: feed, card click, detail and back finish without waiting for DOMContentLoaded / full page load");
  challenge = true;
  const blocked = await api("social/feed", { platform: "x", query: "challenge", limit: 1 });
  assert.equal(blocked.code, "challenge"); assert.equal(blocked.retrySafe, false);
  challenge = false;
  const protectedPage = context.pages().find(p => p.url().includes("challenge"));
  await protectedPage.setContent('<input type="password" value="PRIVATE"><article data-testid="tweet">private</article>');
  const sensitive = await api("social/feed", { platform: "x", query: "challenge", tabRef: feed.tabRef, limit: 1 });
  assert.equal(sensitive.code, "sensitive_page", JSON.stringify(sensitive));
  assert.equal(sensitive.retrySafe, false);
  assert.equal(JSON.stringify(sensitive).includes("PRIVATE"), false);
  assert.equal((await api("social/feed", { platform: "toString" })).code, "invalid_platform");
  assert.deepEqual(writes, []); assert.equal(human.isClosed(), false);
  console.log("PASS failures: missing target has no first-card fallback; stale tab, human navigation, wrong post and challenge stop; zero social writes");
} finally {
  releaseSlow();
  if (controller && controller.exitCode === null) { const stopped = new Promise(r => controller.once("exit", r)); controller.kill(); await stopped; }
  await context?.close();
  // Only the mkdtemp test directory above is removed, never a user profile.
  assert.ok(directory.startsWith(join(tmpdir(), "samewindow-social-read-")));
  await rm(directory, { recursive: true, force: true });
  if (logs.includes("Error")) console.error(logs.slice(-1000));
}
