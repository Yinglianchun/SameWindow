// Host-owned X task templates. Jev chooses only observed, approved navigation actions.
import { runReflex } from "./browser-reflex.mjs";

async function searchX({ query, page, browser, tabRef, api, externalCheck, assertSafe, signal, mode, decide }) {
  const clientStarted = performance.now();
  const home = "https://x.com/home", explore = "https://x.com/explore";
  if (page.url() !== home) {
    await api("/browser/open", { tabRef, url: home, newTab: false });
    await page.getByRole("link", { name: "Search and explore", exact: true }).waitFor({ state: "visible", timeout: 10000 });
  }
  const search = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`;
  let interrupted = false, polling = false, monitorFailure = false;
  const trialStarted = Date.now();
  const monitor = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const state = await api("/user-cursor");
      if (state.cursor?.inside && state.cursor.buttons > 0 && state.cursor.receivedAt >= trialStarted && state.staleMs < 500) interrupted = true;
    }
    catch { monitorFailure = true; }
    finally { polling = false; }
  }, 100);
  function checkControl() { externalCheck(); if (interrupted) throw new Error("viewer_took_control"); if (monitorFailure) throw new Error("cursor_monitor_failed"); if (page.isClosed() || !browser.isConnected()) throw new Error("browser_disconnected"); }
  async function semanticState() {
    await assertSafe();
    return page.evaluate(() => {
      const fields = [...document.querySelectorAll('input[aria-label="Search query"],input[data-testid="SearchBox_Search_Input"]')]
        .filter(e => e.getBoundingClientRect().width > 0);
      const input = fields.length === 1 ? fields[0] : null;
      const links = [...document.querySelectorAll('a[href="/explore"]')].map(e => [e.getAttribute("aria-label"), e.href]);
      const tabs = [...document.querySelectorAll('[role="tab"]')].map(e => e.innerText);
      const error = document.querySelector('main')?.innerText?.includes("Something went wrong") || false;
      return { url: location.href, originTime: performance.timeOrigin, links, tabs, error,
        inputText: input?.value ?? null, activeSearch: input === document.activeElement,
        articles: document.querySelectorAll('main article[data-testid="tweet"]').length,
        noResults: /No results|没有结果|未找到/.test(document.querySelector('main')?.innerText || "") };
    });
  }
  const stamp = state => JSON.stringify([state.url, state.originTime, state.links, state.inputText]);
  let networkDone = false;
  const actionTimings = [];
  const responseListener = response => {
    if (/\/SearchTimeline(?:\?|$)/.test(response.url()) && response.status() === 200) networkDone = true;
  };
  page.on("response", responseListener);
  try {
    const setupMs = Math.round(performance.now() - clientStarted);
    const result = await runReflex({ tabRef,
      goal: `Search X for exactly ${JSON.stringify(query)}. On Home, click Search and explore. On Explore, fill Search query, then press Enter. Stop on the search results page. Do not interact with posts or account settings.`,
      expectedText: "Search results verified", allowedUrls: [home, explore, search],
      approvedActions: [
        { kind: "click", url: home, role: "link", name: "Search and explore", href: explore },
        { kind: "type", url: explore, role: "combobox", name: "Search query", text: query },
        { kind: "press", url: explore, key: "Enter", requiresInputText: query },
      ], maxSteps: 5, deadlineMs: 20000,
    }, {
      checkControl,
      observe: async () => {
        checkControl(); const before = await semanticState();
        const snapshot = (await api("/browser/snapshot", { tabRef, limit: 80 })).snapshot;
        const after = await semanticState();
        if (stamp(before) !== stamp(after)) throw new Error("page_changed_during_snapshot");
        const projected = snapshot.elements.filter(e => e.name === "Search and explore" || e.name === "Search query")
          .map(e => ({ role: e.role, name: e.name, value: e.value, href: e.href }));
        // Jev receives only task controls, never the timeline, private messages or account identifiers.
        return { ...snapshot, stamp: stamp(after), inputText: after.inputText,
          modelText: `Search input: ${JSON.stringify(after.inputText)}. Search result tabs: ${after.tabs.join(", ")}.`,
          modelElements: projected, visibleText: `Search input: ${after.inputText ?? "empty"}; result tabs: ${after.tabs.join(", ")}` };
      },
      fresh: async snapshot => { checkControl(); return stamp(await semanticState()) === snapshot.stamp; },
      act: async (action, snapshot, guard, remainingMs) => {
        await guard();
        const started = performance.now();
        if (action.kind === "click") {
          await api("/browser/click", { tabRef, ref: action.ref, durationMs: 100, reflexGuard: guard, reflexTimeoutMs: Math.min(7000, remainingMs) });
          const executionMs = Math.round(performance.now() - started);
          await page.getByRole("combobox", { name: "Search query", exact: true }).waitFor({ state: "visible", timeout: Math.max(1, Math.min(4000, remainingMs - executionMs)) });
          actionTimings.push({ kind: "click", executionMs, pageReadyMs: Math.round(performance.now() - started) - executionMs });
          return;
        }
        if (action.kind === "type") {
          await api("/browser/type", { tabRef, ref: action.ref, text: action.text, clear: true, submit: false, reflexGuard: guard, reflexTimeoutMs: Math.min(7000, remainingMs) });
          actionTimings.push({ kind: "type", executionMs: Math.round(performance.now() - started), pageReadyMs: 0 });
          return;
        }
        if (action.kind === "press") {
          const state = await semanticState();
          await guard();
          if (!state.activeSearch || state.inputText !== query) throw new Error("search_input_not_focused");
          await api("/browser/press", { tabRef, key: "Enter", waitAfterMs: 0, reflexGuard: async () => {
            await guard(); const current = await semanticState();
            if (!current.activeSearch || current.inputText !== query) throw new Error("search_input_changed");
          } });
          const executionMs = Math.round(performance.now() - started);
          await page.getByRole("tab", { name: /^(Top|热门)$/ }).waitFor({ state: "visible", timeout: Math.max(1, Math.min(4000, remainingMs - executionMs)) });
          actionTimings.push({ kind: "press", executionMs, pageReadyMs: Math.round(performance.now() - started) - executionMs });
          return;
        }
        throw new Error("unsupported_trial_action");
      },
      verify: async (_snapshot, remainingMs) => {
        const readyDeadline = performance.now() + Math.min(6000, remainingMs);
        do {
          checkControl();
          const state = await semanticState(), url = new URL(state.url);
          if (url.origin !== "https://x.com" || url.pathname !== "/search" || url.searchParams.get("q") !== query) return false;
          if (state.error) return false;
          if (state.inputText === query && (state.articles > 0 || state.noResults) && state.tabs.some(t => /Top|Latest|热门|最新/.test(t))) return true;
          await new Promise(r => setTimeout(r, Math.min(150, Math.max(1, readyDeadline - performance.now()))));
        } while (performance.now() < readyDeadline);
        return false;
      },
    }, { mode, signal, decide, allowedSiteOrigins: ["https://x.com"] });
    const report = { query, setupMs, ...result, actionTimings,
      verifiedState: { ...(await semanticState()), networkDone } };
    return report;
  } finally { clearInterval(monitor); page.removeListener("response", responseListener); }
}

async function profileX({ nickname, page, browser, tabRef, api, externalCheck, assertSafe, signal, mode, decide }) {
  const searchUrl = page.url(), peopleUrl = new URL(searchUrl);
  peopleUrl.searchParams.set("f", "user");
  let profileUrl = "", pinnedUrl = "", selectedIdentity = null, interrupted = false, polling = false;
  const startedAt = Date.now();
  const monitor = setInterval(async () => {
    if (polling) return; polling = true;
    try { const r = await api("/user-cursor"); if (r.cursor?.inside && r.cursor.buttons > 0 && r.cursor.receivedAt >= startedAt && r.staleMs < 500) interrupted = true; }
    catch { interrupted = true; } finally { polling = false; }
  }, 100);
  function checkControl() { externalCheck(); if (interrupted) throw new Error("viewer_took_control"); if (!browser.isConnected() || page.isClosed()) throw new Error("browser_disconnected"); }
  async function state() {
    await assertSafe();
    return page.evaluate(nickname => {
      const visible = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
      const profileLink = href => { const u = new URL(href, location.href); return u.origin === "https://x.com" && /^\/[A-Za-z0-9_]{1,15}$/.test(u.pathname); };
      const primary = document.querySelector('main [data-testid="primaryColumn"]') || document.querySelector('main');
      const users = [...(primary?.querySelectorAll('[data-testid="UserCell"]') || [])].filter(visible).map(cell => {
        const links = [...cell.querySelectorAll('a[href]')].filter(a => profileLink(a.href));
        const nameLink = links.find(a => a.innerText.trim() === nickname);
        return { nickname: nameLink?.innerText.trim() ?? null, url: nameLink?.href ?? null,
          summary: cell.innerText.slice(0,500), urls: [...new Set(links.map(a => a.href))] };
      });
      const header = document.querySelector('[data-testid="UserName"]');
      const headerText = header?.innerText ?? "";
      const articles = [...(primary?.querySelectorAll('article[data-testid="tweet"]') || [])].filter(visible);
      const pinned = articles.find(a => /^(Pinned|置顶|已置顶)$/m.test(a.querySelector('[data-testid="socialContext"]')?.innerText || ""));
      const details = article => {
        if (!article) return null;
        const timeLink = article.querySelector('a[href*="/status/"] time')?.closest('a');
        const author = article.querySelector('[data-testid="User-Name"]')?.innerText ?? "";
        return { url: timeLink?.href ?? null, author, text: article.querySelector('[data-testid="tweetText"]')?.innerText ?? "",
          socialContext: article.querySelector('[data-testid="socialContext"]')?.innerText ?? "" };
      };
      return { url: location.href, originTime: performance.timeOrigin, users, headerText,
        pinned: details(pinned), openedPost: details(articles[0]), articles: articles.length,
        scrollY, loadingTimeline: [...(primary?.querySelectorAll('[role="progressbar"]') || [])].some(visible),
        tabs: [...document.querySelectorAll('[role="tab"]')].map(e => e.innerText) };
    }, nickname);
  }
  const stamp = s => JSON.stringify([s.url, s.originTime, s.users.map(u => [u.nickname,u.url]),s.headerText,s.pinned?.url]);
  const allowUrl = url => url === profileUrl || url === pinnedUrl;
  function exactLink(snapshot, url, name) {
    return snapshot.elements.find(e => e.role === "link" && e.href === url && (name === undefined || e.name === name));
  }
  let finalEvidence;
  try {
    const initial = await state();
    if (new URL(initial.url).pathname !== "/search") {
      if (!initial.headerText.split(/\r?\n/).includes(nickname)) throw new Error("initial_profile_identity_mismatch");
      profileUrl = initial.url;
      selectedIdentity = { nickname, url: profileUrl, summary: initial.headerText, source: "observed_current_profile" };
    }
    const result = await runReflex({ goal: `Find the X account whose display name is exactly ${JSON.stringify(nickname)}, inspect its profile identity, then open and read its pinned post. Use only observed account links. Do not guess a username. If names are ambiguous, HANDOFF. Do not follow, like, reply, repost, or publish.`,
      tabRef, allowedUrls: [searchUrl, peopleUrl.href], approvedActions: [], expectedText: "Pinned post verified", maxSteps: 5, deadlineMs: 20000,
    }, {
      checkControl, allowUrl,
      observe: async () => {
        checkControl(); const before = await state();
        const snapshot = (await api("/browser/snapshot", { tabRef, limit: 80 })).snapshot;
        const after = await state(); if (stamp(before) !== stamp(after)) throw new Error("page_changed_during_snapshot");
        const projected = { searchedNickname: nickname, searchTabs: after.tabs,
          accountSearchSelected: new URL(after.url).searchParams.get("f") === "user",
          users: after.users, profile: after.headerText, pinned: after.pinned };
        return { ...snapshot, stamp: stamp(after), evidence: after, modelText: JSON.stringify(projected),
          modelElements: snapshot.elements.filter(e => e.role === "tab" && /^(People|用户|人物)$/.test(e.name) ||
            e.role === "link" && (after.users.some(u => u.url === e.href) || e.href === after.pinned?.url))
            .map(e => ({ role: e.role, name: e.name, href: e.href })), visibleText: JSON.stringify(projected) };
      },
      fresh: async snapshot => stamp(await state()) === snapshot.stamp,
      candidateRules: async snapshot => {
        const s = snapshot.evidence;
        if (s.url === searchUrl) {
          const tab = snapshot.elements.find(e => e.role === "tab" && /^(People|用户|人物)$/.test(e.name) && e.href === peopleUrl.href);
          return tab ? [{ kind: "click", url: s.url, role: tab.role, name: tab.name, href: tab.href, observedRef: tab.ref,
            description: `Show People/account search results for ${nickname} by selecting the observed People tab` }] : [];
        }
        if (s.url === peopleUrl.href) {
          const matches = s.users.filter(u => u.nickname === nickname && u.url);
          const urls = [...new Set(matches.map(u => u.url))];
          if (urls.length > 1) throw new Error("ambiguous_nickname");
          if (urls.length !== 1) return [];
          profileUrl = urls[0]; selectedIdentity = matches[0];
          const link = exactLink(snapshot, profileUrl, nickname);
          return link ? [{ kind: "click", url: s.url, role: link.role, name: link.name, href: profileUrl, observedRef: link.ref,
            description: `Open observed account ${nickname}: ${selectedIdentity.summary}` }] : [];
        }
        if (s.url === profileUrl) {
          const handle = new URL(profileUrl).pathname.slice(1);
          if (!s.headerText.split(/\r?\n/).includes(nickname) || !s.headerText.includes(`@${handle}`)) throw new Error("profile_identity_mismatch");
          if (!s.pinned?.url || new URL(s.pinned.url).pathname.split("/")[1].toLowerCase() !== handle.toLowerCase()) return [];
          pinnedUrl = s.pinned.url;
          const link = exactLink(snapshot, pinnedUrl);
          return link ? [{ kind: "click", url: s.url, role: link.role, name: link.name, href: pinnedUrl, observedRef: link.ref,
            description: `Open the observed pinned post by ${nickname}: ${s.pinned.text.slice(0,500)}` }] : [];
        }
        return [];
      },
      act: async (action, snapshot, guard, remainingMs) => {
        await guard(); await api("/browser/click", { tabRef, ref: action.ref, durationMs: 100, reflexGuard: guard, reflexTimeoutMs: Math.min(7000, remainingMs) });
        const deadline = performance.now() + Math.min(4500, remainingMs);
        while (performance.now() < deadline) {
          checkControl(); const s = await state().catch(error => {
            if (/Execution context was destroyed|Cannot find context|navigation|uninspectable_page/i.test(error.message)) return null;
            throw error;
          });
          if (!s) { await new Promise(r => setTimeout(r, 100)); continue; }
          if (snapshot.url === searchUrl && s.url === peopleUrl.href && s.users.length > 0 ||
              snapshot.url === peopleUrl.href && s.url === profileUrl && s.headerText && s.articles > 0 && !s.loadingTimeline ||
              snapshot.url === profileUrl && s.url === pinnedUrl && s.openedPost?.text) return;
          await new Promise(r => setTimeout(r, 150));
        }
      },
      verify: async () => {
        const s = await state();
        if (profileUrl && s.url === profileUrl && s.headerText.split(/\r?\n/).includes(nickname) &&
            s.articles > 0 && s.scrollY === 0 && !s.loadingTimeline && !s.pinned) {
          await new Promise(r => setTimeout(r, 500));
          const confirmed = await state();
          if (confirmed.url === profileUrl && confirmed.articles > 0 && !confirmed.pinned && !confirmed.loadingTimeline) {
            finalEvidence = { identity: selectedIdentity, profileUrl, result: "no_pinned_post_visible_at_profile_top",
              firstVisiblePost: confirmed.openedPost, verifiedTwice: true };
            return true;
          }
        }
        if (!pinnedUrl || s.url !== pinnedUrl || s.openedPost?.url !== pinnedUrl || !s.openedPost.text) return false;
        const handle = new URL(profileUrl).pathname.slice(1);
        if (!s.openedPost.author.includes(`@${handle}`)) return false;
        finalEvidence = { identity: selectedIdentity, profileUrl, pinnedUrl, post: s.openedPost };
        return true;
      },
    }, { mode, signal, decide, allowedSiteOrigins: ["https://x.com"] });
    const report = { nickname, ...result, evidence: finalEvidence ?? await state() };
    return report;
  } finally { clearInterval(monitor); }
}

export async function runBrowserTask(value, context) {
  const { operation, text } = value;
  if (!["x_search", "x_profile_pinned"].includes(operation) || typeof text !== "string" ||
      !text.trim() || text.length > 80) throw new Error("invalid_browser_task");
  const started = performance.now();
  const search = await searchX({ ...context, query: text });
  let profile = null;
  if (operation === "x_profile_pinned" && search.status === "completed") {
    context.externalCheck();
    profile = await profileX({ ...context, nickname: text });
  }
  context.externalCheck();
  const result = profile ?? search;
  const page = await context.api("/browser/snapshot", { tabRef: context.tabRef, limit: 80 });
  return { status: result.status, stopReason: result.stopReason, operation, text,
    elapsedMs: Math.round(performance.now() - started), phases: { search, ...(profile ? { profile } : {}) },
    snapshot: page.snapshot, contentSource: "browser_dom", contentUntrusted: true };
}
