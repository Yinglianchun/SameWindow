import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createSocialReader } from "../src/social-read.mjs";

// Exercise the real watch scheduler without connecting to a user's browser.
const source = await readFile(new URL("../src/control-server.mjs", import.meta.url), "utf8");
let now = 100_000;
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
class Page extends EventEmitter {
  address = "https://example.test/first";
  installs = 0;
  cleanups = 0;
  titleReads = 0;
  frame = {};
  mainFrame() { return this.frame; }
  url() { return this.address; }
  async title() { this.titleReads++; return "Example"; }
  isClosed() { return false; }
  async exposeBinding(name, callback) { this.binding = callback; }
  async evaluate(fn) {
    if (fn.name === "installPageWatchObserver") this.installs++;
    else this.cleanups++;
  }
  notify(contentChanged = true, visible = true) {
    this.binding({ frame: this.frame }, { contentChanged, visible, focused: visible });
  }
}
const page = new Page();
const background = new Page();
background.address = "https://example.test/background";
const browserContext = new EventEmitter();
browserContext.pages = () => [page, background];
const browser = { isConnected: () => true, contexts: () => [browserContext] };
let activePage = page;
let text = "Original article";
let skipped = false;
const captures = [];
const scope = vm.createContext({
  Date: Clock, URL, createHash, console, createSocialReader,
  process: { env: {} },
  chromium: { connectOverCDP: async () => browser },
  activePage: () => activePage,
  extract: async (fingerprint, options) => {
    captures.push({ fingerprint, preview: options?.contentOnly === true });
    return { fingerprint, tabRef: "test", url: activePage.url(), title: "Example", text, skipped };
  },
});
vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").split("const server = http.createServer")[0], scope);
vm.runInContext(`
  findObservedPage = async () => activePage();
  extractVisiblePageText = extract;
  assertPageSafe = async () => {};
`, scope);
// getBrowser registers a disconnect handler in normal operation.
browser.once = () => {};
const run = (code) => vm.runInContext(code, scope);
const tick = async (ms) => { now += ms; await run("observeWatchState()"); };
const events = (type) => run("semanticEvents").filter((event) => event.type === type);

await run("setWatchState({ enabled: true })");
assert.equal(page.installs, 1);
assert.equal(background.installs, 1);
await tick(1000);
const initialReads = page.titleReads;
for (let index = 0; index < 13; index++) await tick(1000);
assert.equal(page.titleReads, initialReads, "idle page should not be polled for title/focus");
assert.equal(captures.length, 0);
await tick(1000);
assert.equal(events("page_text").length, 1, "initial text still arrives at 15 seconds");

page.address = "https://example.test/second";
page.emit("framenavigated", page.frame);
await tick(1000);
await tick(4999);
assert.equal(events("page_change").length, 0);
await tick(1001);
assert.equal(events("page_change").length, 1, "navigation preview keeps its five-second delay");
await tick(9000);
assert.equal(events("page_text").length, 2);

text = "Original article plus a new comment";
page.notify();
for (let index = 0; index < 7; index++) {
  await tick(2000);
  page.notify();
}
assert.equal(events("page_text").length, 2);
await tick(1000);
assert.equal(events("page_text").length, 3, "ongoing mutations must not postpone capture forever");
page.notify();
await tick(15000);
assert.equal(events("page_text").length, 3, "unchanged text is deduplicated");

const reads = page.titleReads;
background.notify(true, false);
await tick(1000);
assert.equal(page.titleReads, reads, "hidden-tab mutations do not wake the active page");
activePage = background;
background.notify(false);
await tick(1000);
await tick(5000);
assert.equal(events("page_change").length, 2, "tab activation is observed");

await tick(10000);
background.emit("framenavigated", background.frame);
text = "Updated after same-URL reload";
await tick(1000);
await tick(14000);
assert.equal(events("page_text").at(-1).text, text, "same-URL reload re-arms text capture");

skipped = true;
const textEvents = events("page_text").length;
background.notify();
await tick(15000);
assert.equal(events("page_text").length, textEvents, "skipped extraction never produces text");

await run("setWatchState({ enabled: false })");
assert.ok(page.cleanups > 0 && background.cleanups > 0);
background.notify();
await tick(30000);
assert.equal(run("semanticEvents.length"), 0, "disabled watch stays quiet");
await run("setWatchState({ enabled: true })");
assert.equal(page.installs, 2, "watch can be enabled again without duplicate bindings");
console.log("Browser watch observer verified: idle, 5s/15s timing, live updates, dedup, tabs, reload, skip, off/on.");
