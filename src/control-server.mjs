import http from "node:http";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { chromium } from "playwright-core";


const host = process.env.SAMEWINDOW_CONTROL_HOST || "127.0.0.1";
const port = Number(process.env.SAMEWINDOW_CONTROL_PORT || 6081);
const cdpPort = process.env.SAMEWINDOW_CDP_PORT || "9222";
const cdpUrl = process.env.SAMEWINDOW_CDP_URL || `http://127.0.0.1:${cdpPort}`;
const cursorCoordinateMode = process.env.SAMEWINDOW_CURSOR_COORDINATE_MODE || "screen";
const cursorStateFile = process.env.SAMEWINDOW_CURSOR_STATE_FILE
  || "/var/lib/samewindow/novnc-web/cursor-state.json";
const allowSensitiveAutomation = process.env.SAMEWINDOW_ALLOW_SENSITIVE_AUTOMATION === "1";
const cursorNearCooldownMs = 10 * 60 * 1000;
const pageChangeDwellMs = 5 * 1000;
const pageTextCaptureDelayMs = 15 * 1000;
const pageTextRetryDelayMs = 10 * 1000;
const pagePreviewMaxChars = 3000;
const pageTextMaxChars = 8000;
const allowedOrigins = new Set(
  (process.env.SAMEWINDOW_ALLOWED_ORIGINS
    || "http://127.0.0.1:6080,http://localhost:6080")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const interactiveSelector = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let cursorState = {
  available: false,
  inside: false,
  x: null,
  y: null,
  buttons: 0,
  pointerType: "mouse",
  receivedAt: null,
};
let visualCursorState = {
  visible: false,
  x: null,
  y: null,
  updatedAt: null,
};
let watchState = {
  enabled: false,
  enabledAt: null,
  updatedAt: Date.now(),
};
let semanticEvents = [];
let nextSemanticSequence = 1;
let dwellAnchor = null;
let lastDwellSignature = "";
let cursorWasNearAgent = false;
let lastNearEmittedAt = 0;
let lastPageFingerprint = "";
let pageChangeCandidate = null;
let lastPageCheckAt = 0;
let lastClickAt = 0;
let pageStableSince = 0;
let pageTextCapturedFingerprint = "";
let pageTextCaptureInFlight = false;
let pageTextLastAttemptAt = 0;
let pageTextHashes = new Map();
let pageTextCaptureGeneration = 0;
let browserConnection = null;
let selectedPage = null;
let selectedPageObservedAt = 0;
let nextTabSequence = 1;
let nextElementSequence = 1;
let nextSnapshotSequence = 1;
let cursorSequence = Date.now();
let pageToRef = new WeakMap();
let refToPage = new Map();
let elementRefs = new Map();

function sendJson(response, status, value, origin = null) {
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(`${JSON.stringify(value)}\n`);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
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

function validateCursorState(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new Error("x and y must be normalized coordinates");
  }

  return {
    available: true,
    inside: value.inside === true,
    x,
    y,
    buttons: Number.isInteger(value.buttons) ? value.buttons : 0,
    pointerType: typeof value.pointerType === "string" ? value.pointerType : "mouse",
    canvasWidth: Number(value.canvasWidth) || null,
    canvasHeight: Number(value.canvasHeight) || null,
    clientTs: Number(value.clientTs) || null,
    receivedAt: Date.now(),
  };
}

function validateUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048) throw new Error("url is required");
  const url = new URL(raw);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("only http and https URLs are allowed");
  }
  return url.toString();
}

function cleanString(value, maxLength = 500) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function publicTarget(target) {
  if (!target) return null;
  const element = target.element ?? null;
  return {
    region: cleanString(target.region, 40) || null,
    element: element ? {
      tag: cleanString(element.tag, 40) || null,
      id: cleanString(element.id, 100) || null,
      role: cleanString(element.role, 80) || null,
      ariaLabel: cleanString(element.ariaLabel, 180) || null,
      title: cleanString(element.title, 180) || null,
      href: cleanString(element.href, 500) || null,
      text: cleanString(element.text, 180) || null,
    } : null,
  };
}

function targetSignature(target) {
  return JSON.stringify(publicTarget(target));
}

function emitSemanticEvent(type, details = {}) {
  if (!watchState.enabled) return null;
  const event = {
    sequence: nextSemanticSequence++,
    type,
    at: new Date().toISOString(),
    ...details,
  };
  semanticEvents.push(event);
  if (semanticEvents.length > 100) semanticEvents = semanticEvents.slice(-100);
  return event;
}

async function pageObservation(requireSafe = false) {
  const page = await findObservedPage();
  if (requireSafe) await assertPageSafe(page, "semantic observation");
  return {
    tabRef: getTabRef(page),
    title: cleanString(await page.title(), 200),
    url: cleanString(page.url(), 2048),
  };
}

function pageTextHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function rememberPageTextHash(fingerprint, hash) {
  pageTextHashes.delete(fingerprint);
  pageTextHashes.set(fingerprint, hash);
  while (pageTextHashes.size > 30) {
    pageTextHashes.delete(pageTextHashes.keys().next().value);
  }
}

function sensitivePageReason(page) {
  let url;
  try {
    url = new URL(page.url);
  } catch {
    return "unsupported_url";
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) return "unsupported_url";
  const route = `${url.pathname} ${url.search}`.toLowerCase();
  const sensitiveRoute = /(?:^|[\/?&=_-])(?:log-?in|sign-?in|auth|oauth|verify|verification|password|passkey|checkout|payment|billing|wallet|bank|credit-?card|identity|security)(?:$|[\/?&=_-])/i;
  const sensitiveTitle = /(?:verify your identity|one[- ]time (?:code|password)|enter (?:your )?password|sign in|log in|payment|checkout)/i;
  if (sensitiveRoute.test(route)) return "sensitive_url";
  if (sensitiveTitle.test(page.title || "")) return "sensitive_title";
  return "";
}

async function sensitiveFormReason(page) {
  return page.evaluate(() => {
    const isRendered = (element) => {
      if (!(element instanceof Element)) return false;
      if (element.closest("[hidden], [aria-hidden='true']")) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity) !== 0
        && element.getClientRects().length > 0;
    };
    const sensitiveSelector = [
      "input[type='password']",
      "input[autocomplete='current-password']",
      "input[autocomplete='new-password']",
      "input[autocomplete='one-time-code']",
      "input[autocomplete^='cc-']",
      "input[name*='otp' i]",
      "input[name*='verification' i]",
      "input[name*='cardnumber' i]",
      "input[name*='cvv' i]",
      "input[name*='cvc' i]",
    ].join(",");
    return [...document.querySelectorAll(sensitiveSelector)].some(isRendered)
      ? "sensitive_form"
      : "";
  }).catch(() => "uninspectable_page");
}

async function assertPageSafe(page, operation) {
  if (allowSensitiveAutomation) return;
  const observation = {
    title: cleanString(await page.title(), 200),
    url: cleanString(page.url(), 2048),
  };
  const reason = sensitivePageReason(observation) || await sensitiveFormReason(page);
  if (reason) {
    throw new Error(
      `${operation} blocked on a sensitive page (${reason}); complete this step manually in the shared viewer`,
    );
  }
}

async function extractVisiblePageText(expectedFingerprint, options = {}) {
  const page = await findObservedPage();
  const observation = {
    tabRef: getTabRef(page),
    title: cleanString(await page.title(), 200),
    url: cleanString(page.url(), 2048),
  };
  const fingerprint = `${observation.tabRef}\n${observation.url}`;
  if (fingerprint !== expectedFingerprint) return { stale: true };

  const reason = sensitivePageReason(observation);
  if (reason) return { skipped: true, reason, fingerprint };

  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : pageTextMaxChars;
  const contentOnly = options.contentOnly === true;
  const extracted = await page.evaluate(({ maxChars, contentOnly }) => {
    const renderedCache = new WeakMap();
    const isRendered = (element) => {
      if (!(element instanceof Element)) return false;
      if (renderedCache.has(element)) return renderedCache.get(element);
      if (element.closest("[hidden], [aria-hidden='true']")) return false;
      const style = window.getComputedStyle(element);
      const rendered = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && element.getClientRects().length > 0;
      renderedCache.set(element, rendered);
      return rendered;
    };
    const sensitiveSelector = [
      "input[type='password']",
      "input[autocomplete='current-password']",
      "input[autocomplete='new-password']",
      "input[autocomplete='one-time-code']",
      "input[autocomplete^='cc-']",
      "input[name*='otp' i]",
      "input[name*='verification' i]",
      "input[name*='cardnumber' i]",
      "input[name*='cvv' i]",
      "input[name*='cvc' i]",
    ].join(",");
    if ([...document.querySelectorAll(sensitiveSelector)].some(isRendered)) {
      return { skipped: true, reason: "sensitive_form" };
    }

    const compact = (raw, limit = maxChars) => String(raw || "").replace(/\s+/g, " ").trim().slice(0, limit);
    if (contentOnly) {
      const noteId = location.pathname.split("/").filter(Boolean).at(-1) || "";
      const note = globalThis.__INITIAL_STATE__?.note?.noteDetailMap?.[noteId]?.note || {};
      const structuredText = compact(note.desc, maxChars);
      if (structuredText) {
        return {
          text: structuredText,
          source: "page-state",
          truncated: String(note.desc || "").trim().length > maxChars,
        };
      }
    }

    const rootSelector = contentOnly
      ? "article, [class*='note-content' i], [class*='post-content' i], main, [role='main']"
      : "article, main, [role='main']";
    const roots = [...document.querySelectorAll(rootSelector)].filter(isRendered);
    const root = roots.reduce((best, candidate) => {
      const length = String(candidate.innerText || "").trim().length;
      return length > best.length ? { element: candidate, length } : best;
    }, { element: null, length: 0 }).element || document.body;
    if (!root) return { text: "", source: "none", truncated: false };

    const skipSelector = [
      "script, style, noscript, svg, canvas, input, textarea, select, option, [hidden], [aria-hidden='true']",
      contentOnly
        ? "nav, aside, footer, [class*='comment' i], [id*='comment' i], [data-testid*='comment' i], [aria-label*='comment' i], [aria-label*='评论' i]"
        : "",
    ].filter(Boolean).join(",");
    const blockSelector = "h1, h2, h3, h4, h5, h6, p, li, dt, dd, blockquote, pre, figcaption, caption, th, td, article, section, div";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const lines = [];
    let currentBlock = null;
    let currentLine = "";
    let collectedChars = 0;
    let visited = 0;
    const flush = () => {
      const line = currentLine.trim().replace(/\s+/g, " ");
      if (line && line !== lines[lines.length - 1]) {
        lines.push(line);
        collectedChars += line.length + 1;
      }
      currentLine = "";
    };

    while (walker.nextNode() && visited < 30000) {
      visited += 1;
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(skipSelector) || !isRendered(parent)) continue;
      const value = String(node.nodeValue || "").trim().replace(/\s+/g, " ");
      if (!value) continue;
      const block = parent.closest(blockSelector) || parent;
      if (currentBlock && block !== currentBlock) flush();
      currentBlock = block;
      currentLine += `${currentLine ? " " : ""}${value}`;
      if (collectedChars + currentLine.length > maxChars * 1.2) break;
    }
    flush();
    const fullText = lines.join("\n").trim();
    const source = root === document.body
      ? "body"
      : `${root.tagName.toLowerCase()}${root.getAttribute("role") ? `[role=${root.getAttribute("role")}]` : ""}`;
    return {
      text: fullText.slice(0, maxChars),
      source,
      truncated: fullText.length > maxChars || visited >= 30000,
    };
  }, { maxChars, contentOnly });

  const endingFingerprint = `${getTabRef(page)}\n${cleanString(page.url(), 2048)}`;
  if (endingFingerprint !== expectedFingerprint) return { stale: true };
  return { ...extracted, ...observation, fingerprint };
}

async function captureStablePageText(fingerprint, stableMs) {
  const generation = pageTextCaptureGeneration;
  pageTextCaptureInFlight = true;
  pageTextLastAttemptAt = Date.now();
  try {
    const result = await extractVisiblePageText(fingerprint);
    if (
      generation !== pageTextCaptureGeneration ||
      result?.stale ||
      fingerprint !== lastPageFingerprint ||
      !watchState.enabled
    ) return;
    if (result?.skipped) {
      pageTextCapturedFingerprint = fingerprint;
      return;
    }
    const text = String(result?.text || "").trim();
    if (!text) return;
    const textHash = pageTextHash(text);
    pageTextCapturedFingerprint = fingerprint;
    if (pageTextHashes.get(fingerprint) === textHash) return;
    rememberPageTextHash(fingerprint, textHash);
    emitSemanticEvent("page_text", {
      tabRef: result.tabRef,
      title: result.title,
      url: result.url,
      text,
      textChars: text.length,
      textHash,
      truncated: result.truncated === true,
      source: result.source || "body",
      stableMs,
    });
  } catch {
    // Dynamic pages can detach while text is collected; retry while the page stays put.
  } finally {
    if (generation === pageTextCaptureGeneration) pageTextCaptureInFlight = false;
  }
}

async function cursorObservation(state) {
  const page = await pageObservation(true);
  const target = state.available && state.inside ? await evaluateAtCursor(state) : null;
  return { ...page, target: publicTarget(target) };
}

function resetWatchTracking() {
  pageTextCaptureGeneration += 1;
  dwellAnchor = null;
  lastDwellSignature = "";
  cursorWasNearAgent = false;
  lastPageFingerprint = "";
  pageChangeCandidate = null;
  lastPageCheckAt = 0;
  lastClickAt = 0;
  pageStableSince = 0;
  pageTextCapturedFingerprint = "";
  pageTextCaptureInFlight = false;
  pageTextLastAttemptAt = 0;
  pageTextHashes = new Map();
}

async function setWatchState(value) {
  const enabled = value?.enabled === true;
  watchState = {
    enabled,
    enabledAt: enabled ? new Date().toISOString() : null,
    updatedAt: Date.now(),
  };
  semanticEvents = [];
  resetWatchTracking();
  if (enabled) {
    try {
      const page = await pageObservation();
      lastPageFingerprint = `${page.tabRef}\n${page.url}`;
      pageStableSince = Date.now();
    } catch {
      lastPageFingerprint = "";
    }
  }
  return watchState;
}

async function handleCursorUpdate(previous, current) {
  if (!watchState.enabled) return;
  if (!current.inside) {
    cursorWasNearAgent = false;
    return;
  }

  if ((previous?.buttons || 0) === 0 && current.buttons > 0) {
    lastClickAt = Date.now();
    try {
      emitSemanticEvent("click", await cursorObservation(current));
    } catch {
      emitSemanticEvent("click", { target: null });
    }
  }

  if (visualCursorState.visible && Number.isFinite(visualCursorState.x) && Number.isFinite(visualCursorState.y)) {
    const distance = Math.hypot(current.x - visualCursorState.x, current.y - visualCursorState.y);
    const isNear = cursorWasNearAgent ? distance <= 0.05 : distance <= 0.035;
    const now = Date.now();
    if (isNear && !cursorWasNearAgent && now - lastNearEmittedAt >= cursorNearCooldownMs) {
      lastNearEmittedAt = now;
      try {
        emitSemanticEvent("cursor_near_agent", await cursorObservation(current));
      } catch {
        emitSemanticEvent("cursor_near_agent", { target: null });
      }
    }
    cursorWasNearAgent = isNear;
  } else {
    cursorWasNearAgent = false;
  }
}

async function observeWatchState() {
  if (!watchState.enabled) return;
  const now = Date.now();

  if (now - lastPageCheckAt >= 1000) {
    lastPageCheckAt = now;
    try {
      const page = await pageObservation();
      const fingerprint = `${page.tabRef}\n${page.url}`;
      if (!lastPageFingerprint) {
        pageStableSince = now;
        pageTextCapturedFingerprint = "";
      } else if (fingerprint !== lastPageFingerprint) {
        pageChangeCandidate = {
          fingerprint,
          page,
          since: now,
          followsClick: now - lastClickAt < 2000,
        };
        pageStableSince = now;
        pageTextCapturedFingerprint = "";
        pageTextLastAttemptAt = 0;
      } else if (pageChangeCandidate?.fingerprint === fingerprint) {
        pageChangeCandidate.page = page;
        if (now - pageChangeCandidate.since >= pageChangeDwellMs) {
          const candidate = pageChangeCandidate;
          pageChangeCandidate = null;
          const safePage = await pageObservation(true);
          const safeFingerprint = `${safePage.tabRef}\n${safePage.url}`;
          if (safeFingerprint === candidate.fingerprint) {
            const preview = await extractVisiblePageText(candidate.fingerprint, {
              contentOnly: true,
              maxChars: pagePreviewMaxChars,
            }).catch(() => null);
            const previewText = String(preview?.text || "").trim();
            const event = {
              ...safePage,
              dwellMs: now - candidate.since,
              followsClick: candidate.followsClick,
            };
            if (previewText) {
              event.text = previewText;
              event.textChars = previewText.length;
              event.truncated = preview?.truncated === true;
              event.source = preview?.source || "content";
            }
            emitSemanticEvent("page_change", event);
          }
        }
      }
      lastPageFingerprint = fingerprint;
    } catch {
      // Shared Chrome may be between pages; the next interval retries.
    }
  }

  if (
    lastPageFingerprint &&
    pageStableSince > 0 &&
    now - pageStableSince >= pageTextCaptureDelayMs &&
    pageTextCapturedFingerprint !== lastPageFingerprint &&
    !pageTextCaptureInFlight &&
    now - pageTextLastAttemptAt >= pageTextRetryDelayMs
  ) {
    await captureStablePageText(lastPageFingerprint, now - pageStableSince);
  }

  if (pageChangeCandidate) {
    dwellAnchor = null;
    return;
  }

  if (!cursorState.available || !cursorState.inside || !cursorState.receivedAt || now - cursorState.receivedAt > 5000) {
    dwellAnchor = null;
    return;
  }

  const moved = !dwellAnchor || Math.hypot(cursorState.x - dwellAnchor.x, cursorState.y - dwellAnchor.y) > 0.008;
  if (moved) {
    dwellAnchor = { x: cursorState.x, y: cursorState.y, since: now };
    return;
  }
  if (now - dwellAnchor.since < 1200) return;

  try {
    const observation = await cursorObservation(cursorState);
    const signature = `${observation.tabRef}\n${observation.url}\n${targetSignature(observation.target)}`;
    if (signature !== lastDwellSignature) {
      lastDwellSignature = signature;
      emitSemanticEvent("dwell", observation);
    }
  } catch {
    // A transient navigation should not turn ordinary pointer movement into noise.
  }
}

function resetBrowserState() {
  browserConnection = null;
  selectedPage = null;
  selectedPageObservedAt = 0;
  pageToRef = new WeakMap();
  refToPage = new Map();
  elementRefs = new Map();
}

async function getBrowser() {
  if (browserConnection?.isConnected()) return browserConnection;
  resetBrowserState();
  browserConnection = await chromium.connectOverCDP(cdpUrl, { timeout: 5000 });
  browserConnection.once("disconnected", resetBrowserState);
  return browserConnection;
}

async function getPages() {
  const browser = await getBrowser();
  return browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed());
}

function getTabRef(page) {
  let ref = pageToRef.get(page);
  if (!ref) {
    ref = `tab-${nextTabSequence++}`;
    pageToRef.set(page, ref);
    refToPage.set(ref, page);
  }
  return ref;
}

async function findPage(tabRef = "", bringToFront = false) {
  const pages = await getPages();
  for (const page of pages) getTabRef(page);

  let page = tabRef ? refToPage.get(tabRef) : selectedPage;
  if (!page || page.isClosed() || !pages.includes(page)) {
    page = pages[0] ?? null;
  }
  if (!page) throw new Error("no shared Chrome page is open");
  selectedPage = page;
  if (bringToFront) await page.bringToFront();
  return page;
}

async function findObservedPage() {
  const pages = await getPages();
  for (const page of pages) getTabRef(page);
  if (
    selectedPage
    && !selectedPage.isClosed()
    && pages.includes(selectedPage)
    && Date.now() - selectedPageObservedAt < 2000
  ) {
    return selectedPage;
  }
  for (const page of pages) {
    const state = await page.evaluate(() => ({
      focused: document.hasFocus(),
      visibility: document.visibilityState,
    })).catch(() => null);
    if (state?.focused) {
      selectedPage = page;
      return page;
    }
  }
  for (const page of pages) {
    const visibility = await page.evaluate(() => document.visibilityState).catch(() => "hidden");
    if (visibility === "visible") {
      selectedPage = page;
      return page;
    }
  }
  return findPage("", false);
}

async function pageGeometry(page) {
  const geometry = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));
  return {
    tabRef: getTabRef(page),
    title: cleanString(await page.title(), 200),
    url: cleanString(page.url(), 2048),
    ...geometry,
  };
}

function normalizedAddressHint(value) {
  return cleanString(value, 2048)
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

async function observeNativeTab(value) {
  const pages = await getPages();
  for (const page of pages) getTabRef(page);
  const title = cleanString(value.title, 200);
  const addressHint = normalizedAddressHint(value.address);
  const pageDetails = await Promise.all(pages.map(async (page) => ({
    page,
    title: cleanString(await page.title(), 200),
    url: cleanString(page.url(), 2048),
  })));
  let candidates = title
    ? pageDetails.filter((entry) => entry.title === title)
    : pageDetails;
  if (addressHint) {
    const addressMatches = candidates.filter((entry) => (
      normalizedAddressHint(entry.url).includes(addressHint)
      || addressHint.includes(normalizedAddressHint(entry.url))
    ));
    if (addressMatches.length) candidates = addressMatches;
  }
  const match = candidates[0] ?? null;
  if (!match) {
    throw new Error(`observed Chrome tab was not found: ${title || addressHint || "unknown"}`);
  }
  selectedPage = match.page;
  selectedPageObservedAt = Date.now();
  return pageGeometry(match.page);
}

async function listTabs() {
  const pages = await getPages();
  if (!selectedPage || selectedPage.isClosed() || !pages.includes(selectedPage)) {
    selectedPage = pages[0] ?? null;
  }
  return Promise.all(pages.map(async (page) => ({
    ref: getTabRef(page),
    selected: page === selectedPage,
    title: cleanString(await page.title(), 200),
    url: page.url(),
  })));
}

async function openPage(value) {
  const url = validateUrl(value.url);
  const newTab = value.newTab !== false;
  let page;
  if (newTab) {
    const browser = await getBrowser();
    const context = browser.contexts()[0];
    if (!context) throw new Error("shared Chrome has no browser context");
    page = await context.newPage();
  } else {
    page = await findPage(cleanString(value.tabRef, 50), true);
  }
  selectedPage = page;
  getTabRef(page);
  await page.bringToFront();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  return {
    ref: getTabRef(page),
    title: cleanString(await page.title(), 200),
    url: page.url(),
  };
}

async function selectPage(value) {
  const page = await findPage(cleanString(value.tabRef, 50), true);
  return {
    ref: getTabRef(page),
    title: cleanString(await page.title(), 200),
    url: page.url(),
  };
}

async function closePage(value) {
  const page = await findPage(cleanString(value.tabRef, 50), false);
  const pages = await getPages();
  if (pages.length <= 1) throw new Error("refusing to close the last shared-browser tab");
  const closedRef = getTabRef(page);
  await page.close();
  refToPage.delete(closedRef);
  await clearElementRefs();
  const remaining = (await getPages()).filter((candidate) => !candidate.isClosed());
  selectedPage = remaining[0] ?? null;
  if (selectedPage) await selectedPage.bringToFront();
  return { closed: true, closedRef, tabs: await listTabs() };
}

async function clearElementRefs() {
  const pages = [...new Set([...elementRefs.values()].map((entry) => entry.page))];
  elementRefs.clear();
  await Promise.all(pages.map((page) => page.evaluate(() => {
    document.querySelectorAll("[data-samewindow-snapshot-ref]").forEach((element) => {
      element.removeAttribute("data-samewindow-snapshot-ref");
    });
  }).catch(() => {})));
}

async function snapshotPage(value) {
  const startedAt = performance.now();
  const limit = Math.max(1, Math.min(80, Number(value.limit) || 50));
  const tabRef = cleanString(value.tabRef, 50);
  const page = tabRef
    ? await findPage(tabRef, false)
    : await findObservedPage();
  await assertPageSafe(page, "snapshot");
  elementRefs.clear();
  nextElementSequence = 1;
  const snapshotId = `s${nextSnapshotSequence++}`;
  const snapshot = await page.evaluate(({
    selector,
    limit: maxElements,
    snapshotId: activeSnapshotId,
    includePointerExtras,
  }) => {
    document.querySelectorAll("[data-samewindow-snapshot-ref]").forEach((element) => {
      element.removeAttribute("data-samewindow-snapshot-ref");
    });

    const clean = (input, maxLength = 220) => String(input || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
    const candidates = [];
    const standardNodes = [...document.querySelectorAll(selector)];
    const standardSet = new Set(standardNodes);
    const pointerNodes = [];
    if (includePointerExtras) {
      for (const element of document.querySelectorAll("body *")) {
        if (standardSet.has(element) || !(element instanceof HTMLElement || element instanceof SVGElement)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 ||
            rect.top >= window.innerHeight || rect.left >= window.innerWidth) continue;
        const style = window.getComputedStyle(element);
        if (element.hasAttribute("onclick") || style.cursor === "pointer") pointerNodes.push(element);
        if (pointerNodes.length >= Math.max(maxElements * 3, 180)) break;
      }
    }
    const nodes = [...standardNodes, ...pointerNodes];
    for (const element of nodes) {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
      if (!inViewport) continue;

      const tag = element.tagName.toLowerCase();
      const id = clean(element.id, 100) || null;
      const className = clean(element.getAttribute("class"), 180) || null;
      const role = element.getAttribute("role") || null;
      const ariaLabel = clean(element.getAttribute("aria-label"), 180) || null;
      const placeholder = clean(element.getAttribute("placeholder"), 180) || null;
      const title = clean(element.getAttribute("title"), 180) || null;
      const type = clean(element.getAttribute("type"), 60) || null;
      const text = clean(element.innerText || element.textContent, 220) || null;
      const href = element instanceof HTMLAnchorElement ? clean(element.href, 500) || null : null;
      const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? (type === "password" ? null : clean(element.value, 220) || null)
        : null;
      const checked = "checked" in element ? Boolean(element.checked) : null;
      const selected = "selected" in element ? Boolean(element.selected) : null;
      const pressedRaw = element.getAttribute("aria-pressed");
      const pressed = pressedRaw === "true" ? true : pressedRaw === "false" ? false : null;
      const disabled = "disabled" in element ? Boolean(element.disabled) : element.getAttribute("aria-disabled") === "true";
      candidates.push({
        element,
        tag,
        id,
        className,
        clickableHint: standardSet.has(element) ? "semantic" : "pointer",
        role,
        name: ariaLabel || placeholder || title || text || value || id || className || null,
        ariaLabel,
        placeholder,
        title,
        type,
        text,
        href,
        value,
        checked,
        selected,
        pressed,
        disabled,
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
      if (candidates.length >= Math.max(maxElements * 4, 200)) break;
    }

    const elements = candidates.slice(0, maxElements).map((candidate, index) => {
      const ref = `e${index + 1}`;
      const marker = `${activeSnapshotId}:${ref}`;
      candidate.element.setAttribute("data-samewindow-snapshot-ref", marker);
      const { element: _element, ...metadata } = candidate;
      return { ref, marker, ...metadata };
    });
    const rawVisibleText = document.body?.innerText || "";
    return {
      title: clean(document.title, 200),
      url: location.href,
      visibleText: clean(rawVisibleText, 6000),
      visibleTextTruncated: rawVisibleText.length > 6000,
      elements,
      totalCandidates: candidates.length,
    };
  }, {
    selector: interactiveSelector,
    limit,
    snapshotId,
    includePointerExtras: value.includePointerExtras === true,
  });

  const elements = snapshot.elements.map(({ marker, ...element }) => {
    elementRefs.set(element.ref, {
      page,
      selector: `[data-samewindow-snapshot-ref="${marker}"]`,
      snapshotId,
    });
    nextElementSequence += 1;
    return element;
  });
  return {
    tabRef: getTabRef(page),
    title: snapshot.title,
    url: snapshot.url,
    visibleText: snapshot.visibleText,
    elements,
    truncated: elements.length >= limit || snapshot.visibleTextTruncated,
    totalCandidates: snapshot.totalCandidates,
    timingMs: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}

async function getTarget(value) {
  const page = await findPage(cleanString(value.tabRef, 50), false);
  const ref = cleanString(value.ref, 30);
  if (!ref) throw new Error("ref from a fresh snapshot is required");
  const entry = elementRefs.get(ref);
  if (!entry || entry.page !== page) {
    throw new Error(`element ref ${ref} is stale; take a fresh snapshot`);
  }
  await assertPageSafe(page, "browser action");
  return { page, target: page.locator(entry.selector), ref };
}

async function writeVisualCursor(x, y, click = false, durationMs = null, animate = true) {
  const normalizedX = Number(x);
  const normalizedY = Number(y);
  if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY) ||
      normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
    throw new Error("x and y must be normalized coordinates");
  }
  const state = {
    sequence: ++cursorSequence,
    visible: true,
    x: normalizedX,
    y: normalizedY,
    click: click === true,
    durationMs: Number.isFinite(Number(durationMs)) ? Math.max(0, Math.min(1200, Number(durationMs))) : null,
    animate: animate !== false,
  };
  visualCursorState = {
    visible: true,
    x: normalizedX,
    y: normalizedY,
    updatedAt: Date.now(),
  };
  await writeFile(cursorStateFile, `${JSON.stringify(state)}\n`, "utf8");
  return state;
}

async function cursorCoordinatesForTarget(page, target) {
  await target.scrollIntoViewIfNeeded({ timeout: 5000 });
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no visible bounding box");
  if (cursorCoordinateMode === "page") {
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    return {
      x: Math.max(0, Math.min(1, (box.x + box.width / 2) / viewport.width)),
      y: Math.max(0, Math.min(1, (box.y + box.height / 2) / viewport.height)),
    };
  }
  const geometry = await page.evaluate(() => ({
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  }));
  const sideInset = Math.max(0, (geometry.outerWidth - geometry.innerWidth) / 2);
  const topInset = Math.max(0, geometry.outerHeight - geometry.innerHeight - sideInset);
  const screenX = geometry.screenX + sideInset + box.x + box.width / 2;
  const screenY = geometry.screenY + topInset + box.y + box.height / 2;
  return {
    x: Math.max(0, Math.min(1, screenX / geometry.screenWidth)),
    y: Math.max(0, Math.min(1, screenY / geometry.screenHeight)),
  };
}

async function clickTarget(value) {
  const startedAt = performance.now();
  const { page, target, ref } = await getTarget(value);
  await page.bringToFront();
  const cursor = await cursorCoordinatesForTarget(page, target);
  await writeVisualCursor(cursor.x, cursor.y, true, value.durationMs ?? 220);
  const waitAfterMs = Math.max(0, Math.min(2000, Number(value.waitAfterMs) || 0));
  await target.click({ timeout: 7000, noWaitAfter: waitAfterMs === 0 });
  if (waitAfterMs > 0) await page.waitForTimeout(waitAfterMs);
  return {
    clicked: true,
    ref,
    tabRef: getTabRef(page),
    title: cleanString(await page.title(), 200),
    url: page.url(),
    timingMs: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}

async function pressKey(value) {
  const key = String(value.key ?? "").trim();
  if (!key || key.length > 100 || /[\r\n]/.test(key)) {
    throw new Error("key must contain 1-100 characters without newlines");
  }
  const startedAt = performance.now();
  const page = await findPage(cleanString(value.tabRef, 50), true);
  await assertPageSafe(page, "keypress");
  await page.keyboard.press(key);
  const waitAfterMs = Math.max(0, Math.min(2000, Number(value.waitAfterMs) || 0));
  if (waitAfterMs > 0) await page.waitForTimeout(waitAfterMs);
  return {
    pressed: true,
    key,
    tabRef: getTabRef(page),
    title: cleanString(await page.title(), 200),
    url: page.url(),
    timingMs: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}

async function typeIntoTarget(value) {
  const text = String(value.text ?? "");
  if (!text || text.length > 10000) throw new Error("text must contain 1-10000 characters");
  const { page, target, ref } = await getTarget(value);
  await page.bringToFront();
  const cursor = await cursorCoordinatesForTarget(page, target);
  await writeVisualCursor(cursor.x, cursor.y, false, value.durationMs ?? 180);

  const clear = value.clear !== false;
  if (clear) {
    try {
      await target.fill(text, { timeout: 7000 });
    } catch {
      await target.click({ timeout: 7000 });
      await page.keyboard.press("Control+A");
      await page.keyboard.insertText(text);
    }
  } else {
    await target.click({ timeout: 7000 });
    await page.keyboard.insertText(text);
  }
  if (value.submit === true) await page.keyboard.press("Enter");
  return {
    typed: true,
    typedChars: text.length,
    submitted: value.submit === true,
    ref,
    tabRef: getTabRef(page),
    title: cleanString(await page.title(), 200),
    url: page.url(),
  };
}

async function evaluateAtCursor(state) {
  const page = await findObservedPage();
  await assertPageSafe(page, "pointer inspection");
  return page.evaluate((pointer) => {
    const clientX = pointer.coordinateMode === "page"
      ? pointer.x * window.innerWidth
      : pointer.x * window.screen.width - window.screenX
        - Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    const clientY = pointer.coordinateMode === "page"
      ? pointer.y * window.innerHeight
      : pointer.y * window.screen.height - window.screenY
        - Math.max(
          0,
          window.outerHeight - window.innerHeight
            - Math.max(0, (window.outerWidth - window.innerWidth) / 2),
        );
    if (clientX < 0 || clientY < 0 || clientX > window.innerWidth || clientY > window.innerHeight) {
      return {
        region: "browser-chrome",
        clientX,
        clientY,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    }
    const element = document.elementFromPoint(clientX, clientY);
    if (!element) return { region: "page", clientX, clientY, element: null };
    const rect = element.getBoundingClientRect();
    return {
      region: "page",
      clientX,
      clientY,
      element: {
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        title: element.getAttribute("title"),
        href: element instanceof HTMLAnchorElement ? element.href : null,
        text: (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 180),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      },
    };
  }, { ...state, coordinateMode: cursorCoordinateMode });
}

async function browserStatus() {
  const tabs = await listTabs();
  return {
    ok: true,
    service: "samewindow-control",
    cdpUrl,
    connected: true,
    selectedTabRef: selectedPage ? getTabRef(selectedPage) : null,
    tabCount: tabs.length,
  };
}

async function routeRequest(request, response, origin) {
  const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "samewindow-control" }, origin);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/user-cursor") {
    const staleMs = cursorState.receivedAt ? Date.now() - cursorState.receivedAt : null;
    sendJson(response, 200, { ok: true, cursor: cursorState, staleMs }, origin);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/user-cursor/inspect") {
    const target = cursorState.available && cursorState.inside
      ? await evaluateAtCursor(cursorState)
      : null;
    const staleMs = cursorState.receivedAt ? Date.now() - cursorState.receivedAt : null;
    sendJson(response, 200, { ok: true, cursor: cursorState, staleMs, target }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/user-cursor") {
    const previous = cursorState;
    cursorState = validateCursorState(await readJsonBody(request));
    await handleCursorUpdate(previous, cursorState);
    sendJson(response, 200, { ok: true }, origin);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/browser/watch") {
    sendJson(response, 200, {
      ok: true,
      watch: watchState,
      latestSequence: nextSemanticSequence - 1,
    }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/watch") {
    const watch = await setWatchState(await readJsonBody(request));
    sendJson(response, 200, { ok: true, watch, latestSequence: nextSemanticSequence - 1 }, origin);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/browser/events") {
    const after = Math.max(0, Number(requestUrl.searchParams.get("after")) || 0);
    const limit = Math.max(1, Math.min(50, Number(requestUrl.searchParams.get("limit")) || 20));
    const events = semanticEvents.filter((event) => event.sequence > after).slice(0, limit);
    sendJson(response, 200, {
      ok: true,
      watch: watchState,
      events,
      latestSequence: nextSemanticSequence - 1,
    }, origin);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/browser/status") {
    sendJson(response, 200, await browserStatus(), origin);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/browser/geometry") {
    sendJson(response, 200, {
      ok: true,
      geometry: await pageGeometry(await findObservedPage()),
    }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/observed-tab") {
    sendJson(response, 200, {
      ok: true,
      geometry: await observeNativeTab(await readJsonBody(request)),
    }, origin);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/browser/tabs") {
    sendJson(response, 200, { ok: true, tabs: await listTabs() }, origin);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/browser/user-cursor") {
    const target = cursorState.available && cursorState.inside
      ? await evaluateAtCursor(cursorState)
      : null;
    const staleMs = cursorState.receivedAt ? Date.now() - cursorState.receivedAt : null;
    sendJson(response, 200, { ok: true, cursor: cursorState, staleMs, target }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/open") {
    sendJson(response, 200, { ok: true, tab: await openPage(await readJsonBody(request)) }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/select") {
    sendJson(response, 200, { ok: true, tab: await selectPage(await readJsonBody(request)) }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/close") {
    sendJson(response, 200, { ok: true, result: await closePage(await readJsonBody(request)) }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/shutdown") {
    const browser = await getBrowser();
    await browser.close();
    sendJson(response, 200, { ok: true, closed: true }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/snapshot") {
    sendJson(response, 200, { ok: true, snapshot: await snapshotPage(await readJsonBody(request)) }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/click") {
    sendJson(response, 200, { ok: true, result: await clickTarget(await readJsonBody(request)) }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/type") {
    sendJson(response, 200, { ok: true, result: await typeIntoTarget(await readJsonBody(request)) }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/press") {
    sendJson(response, 200, { ok: true, result: await pressKey(await readJsonBody(request)) }, origin);
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/browser/cursor/move") {
    const value = await readJsonBody(request);
    sendJson(response, 200, {
      ok: true,
      cursor: await writeVisualCursor(value.x, value.y, value.click, value.durationMs, value.animate),
    }, origin);
    return;
  }
  sendJson(response, 404, { ok: false, error: "not found" }, origin);
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin ?? null;
  if (origin && !allowedOrigins.has(origin)) {
    sendJson(response, 403, { ok: false, error: "origin not allowed" });
    return;
  }
  if (request.method === "OPTIONS") {
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Private-Network", "true");
    response.setHeader("Vary", "Origin");
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    await routeRequest(request, response, origin);
  } catch (error) {
    const status = error?.name === "TimeoutError" ? 504 : 400;
    sendJson(response, status, { ok: false, error: cleanString(error?.message || error, 500) }, origin);
  }
});

server.listen(port, host, () => {
  console.log(`SameWindow control listening on http://${host}:${port}`);
});

setInterval(() => {
  observeWatchState().catch(() => {});
}, 250).unref();
