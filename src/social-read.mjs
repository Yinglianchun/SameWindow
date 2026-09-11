// Site selectors and list/detail workflow adapted from blueberriely/ai-social-browser
// (44fc6b6), MIT. See third-party/ai-social-browser.LICENSE.
// Uses the existing shared controller; never starts Chrome or exports credentials.

const HOME = { x: "https://x.com/home", xiaohongshu: "https://www.xiaohongshu.com/explore" };
const LIST_TTL_MS = 3 * 60 * 1000;
const fail = (code, message) => Object.assign(new Error(message), { code });

export function socialUrl(raw, platform = "") {
  let url;
  try { url = new URL(raw); } catch { throw fail("invalid_url", "Use a complete X or Xiaohongshu post URL."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw fail("invalid_url", "Only HTTPS platform URLs without credentials are accepted.");
  }
  const host = url.hostname.toLowerCase();
  let site, id;
  if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host)) {
    site = "x";
    id = url.pathname.match(/^\/(?:[^/]+|i)\/status\/(\d+)\/?$/)?.[1];
  } else if (["xiaohongshu.com", "www.xiaohongshu.com"].includes(host)) {
    site = "xiaohongshu";
    id = url.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase();
  }
  if (!site || !id || (platform && platform !== site)) {
    throw fail("invalid_url", "Use a full post URL from social_feed; preserve Xiaohongshu's xsec_token.");
  }
  url.hash = "";
  return { platform: site, id, url: url.href };
}

// Executed in the page. Only rendered DOM is read; no cookies, storage, or app stores.
export function extractSocial({ platform, detail = false }) {
  const text = (el, max = 12000) => (el?.innerText || el?.textContent || "").trim().slice(0, max);
  const visible = el => !!el && !!el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
  const link = el => {
    try { const u = new URL(el?.getAttribute("href") || "", location.href); return /^https?:$/.test(u.protocol) ? u.href : ""; }
    catch { return ""; }
  };
  const images = el => [...el.querySelectorAll("img")].map(img => img.currentSrc || img.src)
    .filter(src => /^https?:/.test(src)).slice(0, 12);
  if (platform === "x") {
    return [...document.querySelectorAll('article[data-testid="tweet"]')].filter(visible).flatMap(art => {
      // The timestamp permalink identifies the outer tweet; quote cards have their own links.
      const time = art.querySelector("time");
      const permalink = time?.closest('a[href*="/status/"]');
      const url = link(permalink);
      const id = url.match(/\/status\/(\d+)/)?.[1];
      if (!id || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(new URL(url).hostname)) return [];
      const user = art.querySelector('[data-testid="User-Name"]');
      const userLines = text(user, 400).split("\n").map(s => s.trim()).filter(Boolean);
      const count = name => text(art.querySelector(`[data-testid="${name}"]`), 50);
      return [{ id, url, author: userLines[0] || "", handle: userLines.find(s => s.startsWith("@")) || "",
        text: text(art.querySelector('[data-testid="tweetText"]')), time: time?.getAttribute("datetime") || "",
        stats: { replies: count("reply"), reposts: count("retweet") || count("unretweet"), likes: count("like") || count("unlike") },
        likedByMe: !!art.querySelector('[data-testid="unlike"]'),
        images: [...art.querySelectorAll('[data-testid="tweetPhoto"] img')].map(img => img.currentSrc || img.src).filter(s => /^https?:/.test(s)).slice(0, 12),
        hasVideo: !!art.querySelector("video"), truncated: !!art.querySelector('[data-testid="tweet-text-show-more-link"]') }];
    });
  }
  if (!detail) {
    return [...document.querySelectorAll("section.note-item")].filter(visible).flatMap(card => {
      const cover = card.querySelector('a.cover[href], a[href*="/explore/"], a[href*="/search_result/"]');
      const url = link(cover);
      const id = url.match(/\/(?:explore|search_result|discovery\/item)\/([a-f0-9]{24})/i)?.[1]?.toLowerCase();
      if (!id || !["www.xiaohongshu.com", "xiaohongshu.com"].includes(new URL(url).hostname)) return [];
      return [{ id, url, title: text(card.querySelector("a.title, .title"), 1000),
        author: text(card.querySelector(".author .name, .author-wrapper .name"), 200),
        likes: text(card.querySelector(".like-wrapper .count"), 50), images: images(cover),
        hasVideo: !!card.querySelector('.play-icon, [class*="play-icon"]') }];
    });
  }
  const roots = [...document.querySelectorAll("#noteContainer, .note-detail-mask, .note-detail-container, .note-detail")].filter(visible);
  const root = roots.reverse().find(el => el.querySelector("#detail-desc, #detail-title, .note-content"));
  if (!root) return null;
  const comments = [...root.querySelectorAll(".comment-item, .parent-comment, .comment-item-sub")].filter(visible).flatMap(el => {
    const content = el.querySelector(".content .note-text, .content, .comment-content");
    // Parent wrappers may include child comment nodes; emit only the nearest comment record.
    if (!content || content.closest(".comment-item, .parent-comment, .comment-item-sub") !== el) return [];
    return [{ id: el.getAttribute("data-id") || el.id || "", author: text(el.querySelector(".author .name, .author-wrapper .name, .name"), 200),
      text: text(content, 4000), time: text(el.querySelector(".date, .time"), 100),
      isReply: el.matches(".comment-item-sub") || !!el.closest(".reply-container") }];
  });
  const content = root.querySelector("#detail-desc, .note-content");
  return { title: text(root.querySelector("#detail-title"), 1000), text: text(content),
    author: text(root.querySelector(".author-container .username, .author-wrapper .username, .author .name, .author-wrapper a[href*='/user/profile/']"), 200),
    images: [...root.querySelectorAll(".media-container img, .note-slider img, .swiper-slide img, .slider-container img")]
      .map(img => img.currentSrc || img.src).filter(src => /^https?:/.test(src)).filter((src, i, all) => all.indexOf(src) === i).slice(0, 12),
    tags: [...(content?.querySelectorAll(".tag, a[id^='hash-tag']") || [])].map(el => text(el, 100)).slice(0, 30), comments };
}

async function guardSocialPage(page, platform) {
  const state = await page.evaluate(() => {
    const shown = selector => [...document.querySelectorAll(selector)].some(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
    return {
      challenge: /\/i\/flow\/challenge|\/account\/access|captcha|arkoselabs/i.test(location.href)
        || shown('iframe[src*="arkose" i], iframe[src*="captcha" i], #captcha, .captcha-container, .verify-container'),
      login: /\/i\/flow\/login|\/login(?:\?|$)/.test(location.href)
        || shown('.login-container, .login-modal, [data-testid="LoginForm_Login_Button"]'),
    };
  });
  if (state.challenge) throw fail("challenge", "Please complete the platform verification in this browser, then read again.");
  if (state.login) throw fail("login_required", "Please log in manually in this browser.");
  const host = new URL(page.url()).hostname;
  const allowed = platform === "x" ? ["x.com", "www.x.com", "twitter.com", "www.twitter.com"] : ["www.xiaohongshu.com", "xiaohongshu.com"];
  if (!allowed.includes(host)) throw fail("page_changed", "The tab left the requested platform; stopped reading.");
}

export function createSocialReader({ getPages, getBrowser, getTabRef, select, click, scroll, assertSafe }) {
  if (typeof assertSafe !== "function") throw new Error("A sensitive-page guard is required");
  async function guardSensitivePage(page) {
    try { await assertSafe(page, "social read"); }
    catch (error) { throw fail("sensitive_page", error.message); }
  }
  async function guardPage(page, platform) {
    await guardSocialPage(page, platform);
    await guardSensitivePage(page);
  }
  let busy = false;
  const sessions = new Map();
  const now = () => Date.now();
  const count = (n, fallback, max) => Math.max(1, Math.min(max, Number(n) || fallback));
  const samePost = (url, target) => { try { const parsed = socialUrl(url); return parsed.platform === target.platform && parsed.id === target.id; } catch { return false; } };
  const selectors = { x: 'article[data-testid="tweet"]', xiaohongshu: 'section.note-item' };

  async function pageFor(platform, tabRef) {
    const pages = await getPages();
    let page;
    if (tabRef) {
      page = pages.find(p => getTabRef(p) === tabRef);
      if (!page) throw fail("stale_tab", "The requested tab no longer exists; select a fresh tabRef.");
    } else {
      page = sessions.get(platform)?.page;
      if (!page || !pages.includes(page)) {
        const browser = await getBrowser();
        const context = browser.contexts()[0];
        if (!context) throw fail("browser_unavailable", "Shared Chrome has no context.");
        // newPage returns this page directly. No page-event race and no unrelated tab takeover.
        page = await context.newPage();
      }
    }
    if (page.url() !== "about:blank") await guardSensitivePage(page);
    await select(page);
    return page;
  }

  async function navigate(page, url, platform) {
    // Body/cards can already be readable while a script, font, or image is stalled.
    // Navigate only to response commit, then wait for the specific readable DOM below.
    try { await page.goto(url, { waitUntil: "commit", timeout: 15000 }); }
    catch (error) {
      if (error.name === "TimeoutError") throw fail("navigation_timeout", "The platform navigation did not commit within 15 seconds. Check the browser network route before retrying.");
      throw error;
    }
    await guardPage(page, platform);
  }

  async function waitContent(page, platform, detail = false) {
    const selector = platform === "xiaohongshu" && detail ? "#detail-desc, #detail-title" : selectors[platform];
    try { await page.locator(selector).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 8000 }); }
    catch { await guardPage(page, platform); throw fail("content_unavailable", "Content did not load; the page may be empty, unavailable, or its structure has changed."); }
    await guardPage(page, platform);
  }

  async function collect(page, platform, limit, detail = false) {
    const records = new Map();
    let post = null, unchanged = 0;
    const initialUrl = page.url();
    for (let step = 0; step < 7; step++) {
      await guardPage(page, platform);
      if (page.url() !== initialUrl) throw fail("page_changed", "The page changed while reading; stopped.");
      const data = await page.evaluate(extractSocial, { platform, detail });
      const items = platform === "xiaohongshu" && detail ? data?.comments || [] : data || [];
      if (platform === "xiaohongshu" && detail && data) post = data;
      const before = records.size;
      for (const item of items) records.set(item.id || `${item.author}\n${item.text}`, item);
      if (records.size >= limit) break;
      unchanged = records.size === before ? unchanged + 1 : 0;
      if (unchanged >= 2 || step === 6) break;
      await scroll(page, platform === "xiaohongshu" && detail ? "#noteContainer .comments-container, .note-detail-mask .comments-container, .note-detail-container .comments-container" : null);
      await page.waitForTimeout(650);
    }
    return { items: [...records.values()].slice(0, limit), post };
  }

  async function feed(value) {
    const platform = value.platform;
    if (!Object.hasOwn(HOME, platform)) throw fail("invalid_platform", "platform must be x or xiaohongshu.");
    const query = String(value.query || "").trim().slice(0, 100);
    const limit = count(value.limit, 10, 30);
    const url = query ? platform === "x" ? `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`
      : `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}&source=web_explore_feed` : HOME[platform];
    const old = sessions.get(platform);
    const page = await pageFor(platform, value.tabRef);
    sessions.set(platform, { page, url, items: [], at: 0 });
    if (!old || old.page !== page || old.url !== url || page.url() !== url || now() - old.at > LIST_TTL_MS) {
      await navigate(page, url, platform);
    }
    await waitContent(page, platform);
    const result = await collect(page, platform, limit);
    const items = result.items.map(item => ({ ...item, readNavigation: "card_click_available" }));
    sessions.set(platform, { page, url: page.url(), items, at: now() });
    return { ok: true, platform, tabRef: getTabRef(page), url: page.url(), items,
      count: items.length, partial: items.length < limit, listExpiresInSeconds: 180 };
  }

  async function cardFor(page, target) {
    const root = page.locator(selectors[target.platform]);
    // Compare parsed permanent IDs, not arbitrary substring matches or the first article.
    const locate = async () => {
      const handles = await root.elementHandles();
      for (const handle of handles) {
        const selector = target.platform === "x" ? 'time' : 'a.cover[href], a[href*="/explore/"], a[href*="/search_result/"]';
        const links = await handle.$$(selector);
        for (const node of links) {
          const href = await node.evaluate(el => (el.matches("time") ? el.closest("a") : el)?.href || "");
          if (samePost(href, target)) {
            const anchor = await node.evaluateHandle(el => el.matches("time") ? el.closest("a") : el);
            await Promise.all(links.map(link => link.dispose()));
            await Promise.all(handles.map(card => card.dispose()));
            return anchor.asElement();
          }
        }
        await Promise.all(links.map(link => link.dispose()));
      }
      await Promise.all(handles.map(card => card.dispose()));
      return null;
    };
    let card = await locate();
    if (card) return card;
    // A virtualized list may have discarded cards above the current viewport.
    await guardPage(page, target.platform);
    await page.keyboard.press("Control+Home");
    await page.waitForTimeout(400);
    for (let attempt = 0; attempt < 6; attempt++) {
      await guardPage(page, target.platform);
      card = await locate();
      if (card) return card;
      await scroll(page, null);
      await page.waitForTimeout(500);
    }
    throw fail("target_not_found", "The exact post is no longer in the list. No other card was clicked.");
  }

  async function read(value) {
    const target = socialUrl(value.url);
    const limit = count(value.limit, 20, 40);
    const session = sessions.get(target.platform);
    const pages = await getPages();
    const known = session?.items.some(item => samePost(item.url, target));
    const reuse = known && now() - session.at < LIST_TTL_MS && pages.includes(session.page)
      && (!value.tabRef || getTabRef(session.page) === value.tabRef);
    const page = reuse ? session.page : await pageFor(target.platform, value.tabRef);
    await select(page);
    let clicked = false;
    let navigation = "direct_url";
    let output;
    try {
      if (reuse) {
        if (page.url() !== session.url) throw fail("list_changed", "The retained list was navigated elsewhere; read a fresh feed first.");
        await guardPage(page, target.platform);
        const card = await cardFor(page, target);
        try { await click(page, card); clicked = true; } finally { await card.dispose(); }
        navigation = "feed_card_click";
        try { await page.waitForURL(url => samePost(url.href, target), { waitUntil: "commit", timeout: 8000 }); }
        catch { await guardPage(page, target.platform); throw fail("target_mismatch", "The clicked card did not open the requested post."); }
      } else {
        if (!value.tabRef) sessions.set(target.platform, { page, url: target.url, items: [], at: 0 });
        await navigate(page, target.url, target.platform);
      }
      await waitContent(page, target.platform, true);
      if (!samePost(page.url(), target)) throw fail("target_mismatch", "The browser did not reach the requested post.");
      const result = await collect(page, target.platform, target.platform === "x" ? limit + 1 : limit, true);
      const post = target.platform === "x" ? result.items.find(item => item.id === target.id) : result.post;
      if (!post) throw fail("target_not_found", "The exact requested post could not be read; no substitute returned.");
      const { comments: _comments, ...body } = post;
      output = { ok: true, platform: target.platform, tabRef: getTabRef(page), url: target.url, navigation,
        post: { ...body, id: target.id, url: target.url },
        ...(target.platform === "x" ? { thread: result.items.filter(item => item.id !== target.id).slice(0, limit),
          threadNote: "Visible conversation items, not verified direct replies; may include ancestors or recommendations." }
          : { comments: result.items }),
        partial: true, coverage: "Loaded DOM only; comments may be collapsed or not yet loaded.",
        returnedToList: false };
      return output;
    } finally {
      // Never navigate away from a challenge or a page the human has switched to.
      if (clicked && samePost(page.url(), target)) {
        try {
          await guardPage(page, target.platform);
          await page.goBack({ waitUntil: "commit", timeout: 8000 });
          session.at = now();
        } catch (error) {
          if (output) output.restoreError = String(error.message || error).slice(0, 300);
        }
      }
    }
  }

  return async (action, value) => {
    if (busy) return { ok: false, code: "busy", error: "Another social read is active; wait for it to finish.", retrySafe: true };
    busy = true;
    try {
      const result = action === "feed" ? await feed(value) : action === "read" ? await read(value)
        : (() => { throw fail("invalid_action", "Only feed and read are supported."); })();
      if (action === "read" && result.navigation === "feed_card_click") {
        const session = sessions.get(result.platform);
        result.returnedToList = !!session && session.page.url() === session.url;
      }
      return result;
    } catch (error) {
      return { ok: false, code: error.code || "read_failed", error: String(error.message || error).slice(0, 500),
        ...(error.details ? { details: error.details } : {}),
        retrySafe: !["sensitive_page", "challenge", "login_required", "target_not_found", "target_mismatch", "list_changed", "page_changed"].includes(error.code) };
    } finally { busy = false; }
  };
}
