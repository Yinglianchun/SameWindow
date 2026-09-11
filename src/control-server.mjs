import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { chromium } from "playwright-core";
import { createSocialReader } from "./social-read.mjs";


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
let pageObservationDirty = true;
let pageContentChangedAt = 0;
let watchObserverPages = new Map();
let watchObserverContexts = new WeakSet();
let watchObservationInFlight = false;
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
let nextSnapshotSequence = 1;
let cursorSequence = Date.now();
let pageToRef = new WeakMap();
let refToPage = new Map();
let elementRefs = new Map();
let pageOperationLocks = new WeakMap();

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
    const hasSensitiveForm = (root) => [...root.querySelectorAll(sensitiveSelector)].some(isRendered)
      || [...root.querySelectorAll("*")].some(el => el.shadowRoot && hasSensitiveForm(el.shadowRoot));
    return hasSensitiveForm(document)
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

  const reason = sensitivePageReason(observation) || await sensitiveFormReason(page);
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
  pageObservationDirty = true;
  pageContentChangedAt = 0;
  lastClickAt = 0;
  pageStableSince = 0;
  pageTextCapturedFingerprint = "";
  pageTextCaptureInFlight = false;
  pageTextLastAttemptAt = 0;
  pageTextHashes = new Map();
}

function installPageWatchObserver() {
  globalThis.__samewindowWatchCleanup?.();
  let timer;
  let contentChanged = false;
  const notify = (content) => {
    contentChanged ||= content;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const changed = contentChanged;
      contentChanged = false;
      globalThis.__samewindowWatchChanged({
        contentChanged: changed,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
      }).catch(() => {});
    }, 250);
  };
  const observer = new MutationObserver(() => notify(true));
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    // Track visibility/layout changes without watching every site attribute.
    attributeFilter: ["hidden", "aria-hidden", "class", "style"],
  });
  const onVisible = () => notify(true);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  globalThis.__samewindowWatchCleanup = () => {
    observer.disconnect();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    delete globalThis.__samewindowWatchCleanup;
  };
  notify(false);
}

async function attachWatchObserver(page) {
  if (!watchObserverPages.has(page)) {
    const ready = page.exposeBinding("__samewindowWatchChanged", (source, change) => {
      if (!watchState.enabled || source.frame !== page.mainFrame()) return;
      if (!change.visible && !change.focused) return;
      if (change.focused) {
        selectedPage = page;
        selectedPageObservedAt = Date.now();
      }
      pageObservationDirty = true;
      if (change.contentChanged && lastPageFingerprint === `${getTabRef(page)}\n${cleanString(page.url(), 2048)}`) {
        if (pageTextCapturedFingerprint || !pageContentChangedAt) pageContentChangedAt = Date.now();
        pageTextCapturedFingerprint = "";
        pageTextCaptureGeneration += 1;
        pageTextCaptureInFlight = false;
      }
    }).then(() => {
      page.on("domcontentloaded", () => {
        if (watchState.enabled) attachWatchObserver(page).catch(() => {});
      });
      page.on("framenavigated", (frame) => {
        if (!watchState.enabled || frame !== page.mainFrame()) return;
        pageObservationDirty = true;
        if (lastPageFingerprint.startsWith(`${getTabRef(page)}\n`)) {
          pageStableSince = Date.now();
          pageContentChangedAt = 0;
          pageTextCapturedFingerprint = "";
          pageTextCaptureGeneration += 1;
          pageTextCaptureInFlight = false;
        }
      });
      page.on("close", () => {
        watchObserverPages.delete(page);
        pageObservationDirty = true;
      });
    }).catch((error) => {
      watchObserverPages.delete(page);
      throw error;
    });
    watchObserverPages.set(page, ready);
  }
  await watchObserverPages.get(page);
  if (watchState.enabled) await page.evaluate(installPageWatchObserver);
}

async function startWatchObservers() {
  const browser = await getBrowser();
  for (const context of browser.contexts()) {
    if (!watchObserverContexts.has(context)) {
      watchObserverContexts.add(context);
      context.on("page", (page) => {
        if (watchState.enabled) attachWatchObserver(page).catch(() => {});
      });
    }
  }
  await Promise.all((await getPages()).map((page) => attachWatchObserver(page).catch(() => {})));
  pageObservationDirty = true;
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
      await startWatchObservers();
      const page = await pageObservation();
      lastPageFingerprint = `${page.tabRef}\n${page.url}`;
      pageStableSince = Date.now();
    } catch {
      lastPageFingerprint = "";
    }
  } else {
    await Promise.all([...watchObserverPages.keys()].map((page) => (
      page.evaluate(() => globalThis.__samewindowWatchCleanup?.()).catch(() => {})
    )));
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
  if (!browserConnection?.isConnected()) await startWatchObservers();
  const now = Date.now();

  const pageChangeDue = pageChangeCandidate && now - pageChangeCandidate.since >= pageChangeDwellMs;
  if ((pageObservationDirty || pageChangeDue) && now - lastPageCheckAt >= 1000) {
    pageObservationDirty = false;
    lastPageCheckAt = now;
    try {
      const page = await pageObservation();
      const fingerprint = `${page.tabRef}\n${page.url}`;
      if (!lastPageFingerprint) {
        pageStableSince = now;
        pageContentChangedAt = 0;
        pageTextCapturedFingerprint = "";
      } else if (fingerprint !== lastPageFingerprint) {
        pageChangeCandidate = {
          fingerprint,
          page,
          since: now,
          followsClick: now - lastClickAt < 2000,
        };
        pageStableSince = now;
        pageContentChangedAt = 0;
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
      pageObservationDirty = true;
    }
  }

  if (
    lastPageFingerprint &&
    pageStableSince > 0 &&
    now - pageStableSince >= pageTextCaptureDelayMs &&
    (!pageContentChangedAt || now - pageContentChangedAt >= pageTextCaptureDelayMs) &&
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
  pageOperationLocks = new WeakMap();
  watchObserverPages = new Map();
  watchObserverContexts = new WeakSet();
  pageObservationDirty = true;
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

async function findPage(tabRef = "", bringToFront = false, strict = false) {
  const pages = await getPages();
  for (const page of pages) getTabRef(page);

  let page = tabRef ? refToPage.get(tabRef) : selectedPage;
  if (!page || page.isClosed() || !pages.includes(page)) {
    if (strict && tabRef) {
      throw new Error(`browser tab ref ${tabRef} is stale; take a fresh snapshot`);
    }
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
  await clearElementRefs(page);
  const remaining = (await getPages()).filter((candidate) => !candidate.isClosed());
  selectedPage = remaining[0] ?? null;
  if (selectedPage) await selectedPage.bringToFront();
  return { closed: true, closedRef, tabs: await listTabs() };
}

async function clearElementRefs(page = null) {
  for (const [ref, entry] of elementRefs) {
    if (!page || entry.page === page) elementRefs.delete(ref);
  }
}

async function withPageOperationLock(page, operation) {
  const previous = pageOperationLocks.get(page) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  pageOperationLocks.set(page, current);
  try {
    return await current;
  } finally {
    if (pageOperationLocks.get(page) === current) pageOperationLocks.delete(page);
  }
}

async function snapshotPage(value) {
  const startedAt = performance.now();
  const limit = Math.max(1, Math.min(80, Number(value.limit) || 50));
  const tabRef = cleanString(value.tabRef, 50);
  const page = tabRef ? await findPage(tabRef, false, true) : await findObservedPage();
  return withPageOperationLock(page, async () => {
    await assertPageSafe(page, "snapshot");
    await clearElementRefs(page);
    const snapshotId = `s${nextSnapshotSequence++}`;
    const cdp = await page.context().newCDPSession(page);
    try {
      const [ax, dom, summary] = await Promise.all([
        cdp.send("Accessibility.getFullAXTree").catch(() => ({ nodes: [] })),
        cdp.send("DOMSnapshot.captureSnapshot", {
          computedStyles: ["display", "visibility", "opacity", "cursor"],
        }),
        page.evaluate(() => ({
          title: document.title,
          url: location.href,
          text: document.body?.innerText || "",
          width: window.innerWidth,
          height: window.innerHeight,
        })),
      ]);
      // Like the previous snapshot, this describes the main document. DOMSnapshot
      // also includes open shadow roots, without inserting attributes into the page.
      const document = dom.documents[0];
      const { nodes, layout } = document;
      const string = (index) => dom.strings[index] || "";
      const rareStrings = (data) => new Map((data?.index || []).map((index, i) => [index, string(data.value[i])]));
      const inputValues = rareStrings(nodes.inputValue);
      const checked = new Set(nodes.inputChecked?.index || []);
      const selected = new Set(nodes.optionSelected?.index || []);
      const clickable = new Set(nodes.isClickable?.index || []);
      const boxes = new Map(layout.nodeIndex.map((index, i) => [index, i]));
      const axByBackend = new Map(ax.nodes.filter((node) => !node.ignored && node.backendDOMNodeId)
        .map((node) => [node.backendDOMNodeId, node]));
      const interactiveRoles = new Set([
        "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
        "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox",
        "menuitemradio", "option", "tab", "treeitem", "listbox",
      ]);
      const text = nodes.nodeValue.map((value) => cleanString(string(value), 220));
      // Accumulate small text labels in document order for DOM-only controls.
      const children = new Map();
      nodes.parentIndex.forEach((parent, index) => {
        if (parent < 0) return;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(index);
      });
      for (let index = nodes.nodeType.length - 1; index >= 0; index -= 1) {
        if (nodes.nodeType[index] !== 3) {
          text[index] = cleanString((children.get(index) || []).map((child) => text[child]).join(" "), 220);
        }
      }
      const candidates = [];
      for (let index = 0; index < nodes.nodeType.length; index += 1) {
        if (nodes.nodeType[index] !== 1 || !boxes.has(index)) continue;
        const layoutIndex = boxes.get(index);
        const [left, top, width, height] = layout.bounds[layoutIndex];
        const x = left - (document.scrollOffsetX || 0);
        const y = top - (document.scrollOffsetY || 0);
        if (width <= 0 || height <= 0 || x + width <= 0 || y + height <= 0 ||
            x >= summary.width || y >= summary.height) continue;
        const [display, visibility, opacity, cursor] = layout.styles[layoutIndex].map(string);
        if (display === "none" || visibility === "hidden" || visibility === "collapse" || opacity === "0") continue;
        const pairs = nodes.attributes[index] || [];
        const attrs = {};
        for (let i = 0; i < pairs.length; i += 2) attrs[string(pairs[i])] = string(pairs[i + 1]);
        const backendNodeId = nodes.backendNodeId[index];
        const axNode = axByBackend.get(backendNodeId);
        const properties = new Map((axNode?.properties || []).map((prop) => [prop.name, prop.value.value]));
        const tag = string(nodes.nodeName[index]).toLowerCase();
        const role = axNode?.role?.value || attrs.role || null;
        const semantic = axNode && (interactiveRoles.has(role) || properties.get("focusable") === true || properties.has("editable"));
        const domControl = ["button", "input", "textarea", "select"].includes(tag) ||
          (tag === "a" && attrs.href !== undefined) || attrs.contenteditable === "true" ||
          interactiveRoles.has(attrs.role) || (attrs.tabindex !== undefined && attrs.tabindex !== "-1");
        const pointer = value.includePointerExtras === true && (clickable.has(index) || cursor === "pointer");
        if (!semantic && !domControl && !pointer) continue;
        const type = attrs.type?.toLowerCase() || null;
        const inputValue = type === "password" ? null : cleanString(inputValues.get(index), 220) || null;
        const label = cleanString(axNode?.name?.value || attrs["aria-label"] || attrs.placeholder || attrs.title || text[index], 220) || null;
        const baseURL = string(document.baseURL) || summary.url;
        const href = tag === "a" && attrs.href
          ? cleanString(URL.canParse(attrs.href, baseURL) ? new URL(attrs.href, baseURL).href : attrs.href, 500)
          : null;
        candidates.push({
          backendNodeId,
          source: semantic ? "accessibility" : "dom",
          tag, role, name: label,
          id: cleanString(attrs.id, 100) || null,
          className: cleanString(attrs.class, 180) || null,
          clickableHint: semantic || domControl ? "semantic" : "pointer",
          ariaLabel: cleanString(attrs["aria-label"], 180) || null,
          placeholder: cleanString(attrs.placeholder, 180) || null,
          title: cleanString(attrs.title, 180) || null,
          type, text: text[index] || null,
          href,
          value: inputValue,
          checked: properties.has("checked") ? properties.get("checked") === "true" || properties.get("checked") === true : ["checkbox", "radio"].includes(type) ? checked.has(index) : null,
          selected: properties.get("selected") ?? (tag === "option" ? selected.has(index) : null),
          pressed: properties.has("pressed") ? properties.get("pressed") === "true" || properties.get("pressed") === true : null,
          disabled: properties.get("disabled") === true || attrs.disabled !== undefined || attrs["aria-disabled"] === "true",
          box: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
        });
      }
      // Prefer AX controls; DOM-only widgets remain available as a supplement.
      candidates.sort((a, b) => Number(b.source === "accessibility") - Number(a.source === "accessibility"));
      await assertPageSafe(page, "snapshot");
      if (page.url() !== summary.url) throw new Error("page changed during snapshot; take a fresh snapshot");
      const elements = candidates.slice(0, limit).map(({ backendNodeId, ...metadata }, index) => {
        const ref = `${snapshotId}:e${index + 1}`;
        elementRefs.set(ref, { page, backendNodeId, snapshotId, url: summary.url });
        return { ref, ...metadata };
      });
      return {
        snapshotId,
        tabRef: getTabRef(page),
        title: cleanString(summary.title, 200), url: summary.url,
        visibleText: cleanString(summary.text, 6000), elements,
        truncated: candidates.length > elements.length || summary.text.length > 6000,
        totalCandidates: candidates.length,
        timingMs: Math.round((performance.now() - startedAt) * 10) / 10,
      };
    } finally {
      await cdp.detach().catch(() => {});
    }
  });
}

async function resolveNodeTarget(page, entry, ref) {
  const cdp = await page.context().newCDPSession(page);
  const slot = `__samewindowNodeTransfer_${randomUUID()}`;
  let objectId;
  let target;
  try {
    ({ object: { objectId } } = await cdp.send("DOM.resolveNode", { backendNodeId: entry.backendNodeId }));
    if (!objectId) throw new Error("node no longer exists");
    // Transfer this exact browser node to a public Playwright ElementHandle.
    // The short-lived JS slot is removed immediately; no DOM attribute changes
    // or text/CSS re-matching are involved. Playwright keeps its action checks.
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function (slot) { if (!this.isConnected) throw new Error('detached node'); globalThis[slot] = this; }",
      arguments: [{ value: slot }], returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error("node is detached");
    const handle = await page.evaluateHandle((key) => globalThis[key], slot);
    target = handle.asElement();
    if (!target) { await handle.dispose(); throw new Error("node is no longer in this document"); }
    if (!(await target.evaluate((node) => node.isConnected))) throw new Error("node is detached");
    return target;
  } catch (error) {
    await target?.dispose();
    throw browserActionError("stale_ref", `element ref ${ref} is stale; take a fresh snapshot`, {
      reason: cleanString(error.message, 200),
    });
  } finally {
    await page.evaluate((key) => { delete globalThis[key]; }, slot).catch(() => {});
    if (objectId) await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

async function getTarget(value, page) {
  const ref = cleanString(value.ref, 30);
  if (!ref) throw new Error("ref from a fresh snapshot is required");
  const entry = elementRefs.get(ref);
  if (!entry || entry.page !== page || entry.url !== page.url()) {
    throw new Error(`element ref ${ref} is stale; take a fresh snapshot`);
  }
  await assertPageSafe(page, "browser action");
  return { page, target: await resolveNodeTarget(page, entry, ref), ref };
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
  return cursorCoordinatesForPoint(page, box.x + box.width / 2, box.y + box.height / 2);
}

async function cursorCoordinatesForPoint(page, x, y) {
  if (cursorCoordinateMode === "page") {
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    return {
      x: Math.max(0, Math.min(1, x / viewport.width)),
      y: Math.max(0, Math.min(1, y / viewport.height)),
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
  const screenX = geometry.screenX + sideInset + x;
  const screenY = geometry.screenY + topInset + y;
  return {
    x: Math.max(0, Math.min(1, screenX / geometry.screenWidth)),
    y: Math.max(0, Math.min(1, screenY / geometry.screenHeight)),
  };
}

function browserActionError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = 409;
  error.details = details;
  return error;
}

async function targetObstruction(target) {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    const x = Math.max(0, Math.min(window.innerWidth - 1, (left + right) / 2));
    const y = Math.max(0, Math.min(window.innerHeight - 1, (top + bottom) / 2));
    let receiver = document.elementFromPoint(x, y);
    while (receiver?.shadowRoot) {
      const nested = receiver.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === receiver) break;
      receiver = nested;
    }
    if (!receiver || receiver === element || element.contains(receiver)) return null;
    const clean = (input, maxLength = 160) => String(input || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
    return {
      point: { x: Math.round(x), y: Math.round(y) },
      coveredBy: {
        tag: receiver.tagName?.toLowerCase() || null,
        id: clean(receiver.id, 100) || null,
        className: clean(receiver.getAttribute?.("class"), 160) || null,
        role: clean(receiver.getAttribute?.("role"), 80) || null,
        ariaLabel: clean(receiver.getAttribute?.("aria-label"), 160) || null,
        text: clean(receiver.innerText || receiver.textContent, 160) || null,
      },
    };
  });
}

async function assertTargetClickable(target, ref) {
  const obstruction = await targetObstruction(target);
  if (obstruction) {
    const coveredBy = obstruction.coveredBy;
    const label = coveredBy.ariaLabel || coveredBy.text || coveredBy.id || coveredBy.role || coveredBy.tag || "another element";
    throw browserActionError(
      "obstructed",
      `element ref ${ref} is obstructed by ${label}; take a fresh snapshot or ask the user to dismiss the overlay`,
      obstruction,
    );
  }
  try {
    await target.click({ trial: true, timeout: 1500 });
  } catch (error) {
    const reason = cleanString(error?.message || error, 500);
    const code = /intercepts pointer events|not receiving pointer events|obscured|covered/i.test(reason)
      ? "obstructed"
      : "not_actionable";
    throw browserActionError(
      code,
      `element ref ${ref} is not clickable: ${reason}`,
      { playwright: reason },
    );
  }
}

async function clickTarget(value) {
  const startedAt = performance.now();
  const page = await findPage(cleanString(value.tabRef, 50), false, true);
  return withPageOperationLock(page, async () => {
    const { target, ref } = await getTarget(value, page);
    try {
      await page.bringToFront();
      const cursor = await cursorCoordinatesForTarget(page, target);
      await assertTargetClickable(target, ref);
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
    } finally {
      await target.dispose().catch(() => {});
    }
  });
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
  const page = await findPage(cleanString(value.tabRef, 50), false, true);
  return withPageOperationLock(page, async () => {
    const { target, ref } = await getTarget(value, page);
    try {
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
    } finally {
      await target.dispose().catch(() => {});
    }
  });
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

const readSocial = createSocialReader({
  getPages, getBrowser, getTabRef, assertSafe: assertPageSafe,
  select: async (page) => {
    selectedPage = page;
    selectedPageObservedAt = Date.now();
    pageObservationDirty = true;
    await page.bringToFront();
  },
  click: async (page, target) => {
    await assertPageSafe(page, "social click");
    const cursor = await cursorCoordinatesForTarget(page, target);
    await assertTargetClickable(target, "social post");
    await writeVisualCursor(cursor.x, cursor.y, true, 220);
    await target.click({ timeout: 7000, noWaitAfter: true });
  },
  scroll: async (page, selector) => {
    await assertPageSafe(page, "social scroll");
    const target = selector ? page.locator(selector).filter({ visible: true }).first() : null;
    const box = target && await target.count() ? await target.boundingBox() : null;
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const x = box ? box.x + box.width / 2 : viewport.width * 0.55;
    const y = box ? box.y + box.height / 2 : viewport.height * 0.65;
    await page.mouse.move(x, y);
    const cursor = await cursorCoordinatesForPoint(page, x, y);
    await writeVisualCursor(cursor.x, cursor.y, false, 120);
    await page.mouse.wheel(0, 600);
  },
});

async function routeRequest(request, response, origin) {
  const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "POST" && ["/browser/social/feed", "/browser/social/read"].includes(requestUrl.pathname)) {
    const action = requestUrl.pathname.split("/").at(-1);
    sendJson(response, 200, await readSocial(action, await readJsonBody(request)), origin);
    return;
  }

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
    const timeout = error?.name === "TimeoutError";
    const status = Number(error?.httpStatus) || (timeout ? 409 : 400);
    const payload = {
      ok: false,
      error: cleanString(error?.message || error, 500),
    };
    const code = cleanString(error?.code || (timeout ? "action_timeout" : ""), 80);
    if (code) payload.code = code;
    if (error?.details && typeof error.details === "object") payload.details = error.details;
    sendJson(response, status, payload, origin);
  }
});

server.listen(port, host, () => {
  console.log(`SameWindow control listening on http://${host}:${port}`);
});

setInterval(async () => {
  if (watchObservationInFlight) return;
  watchObservationInFlight = true;
  try { await observeWatchState(); } catch {}
  finally { watchObservationInFlight = false; }
}, 250).unref();
