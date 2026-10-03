import { runBrowserTask } from "./browser-tasks.mjs";

// One task per controller. Internal adapters reuse normal safety checks and refs.
export function createTaskController(host) {
  let active = false, epoch = 0;
  const interrupt = () => { epoch++; };
  async function run(value, signal) {
    const mode = process.env.SAMEWINDOW_TASK_MODE || "off";
    if (mode === "off") return { status: "blocked", stopReason: "task_off" };
    if (mode !== "bounded") throw new Error("invalid_task_mode");
    if (!process.env.SAMEWINDOW_JEV_API_KEY) return { status: "blocked", stopReason: "missing_jev_key" };
    if (active) return { status: "blocked", stopReason: "task_busy" };
    if (!["x_search", "x_profile_pinned"].includes(value.operation) || typeof value.text !== "string" || !value.text.trim() || value.text.length > 80) throw new Error("invalid_browser_task");
    const initialEpoch = epoch, started = performance.now();
    const taskSignal = AbortSignal.any([signal, AbortSignal.timeout(55000)]);
    active = true;
    let page;
    const externalCheck = () => {
      taskSignal.throwIfAborted();
      if (epoch !== initialEpoch) throw new Error("external_control_taken");
      if (page && (page.isClosed() || host.selected() !== page || !host.connected())) throw new Error("pinned_browser_changed");
    };
    try {
      page = await host.page(value.tabRef);
      if (!page || new URL(page.url()).origin !== "https://x.com") throw new Error("open_x_first");
      const tabRef = host.ref(page);
      await host.safe(page, "task setup");
      externalCheck();
      await host.select({ tabRef });
      const assertSafe = async () => { externalCheck(); await host.safe(page, "task observation"); externalCheck(); };
      const api = async (route, body = {}) => {
        externalCheck();
        if (body.tabRef && body.tabRef !== tabRef) throw new Error("task_tab_changed");
        if (route === "/user-cursor") return host.cursor();
        if (route === "/browser/snapshot") return { snapshot: await host.snapshot({ ...body, tabRef }) };
        if (route === "/browser/open") {
          if (body.url !== "https://x.com/home") throw new Error("task_url_not_allowed");
          await assertSafe();
          const result = await host.open({ ...body, tabRef, newTab: false });
          await assertSafe(); return { tab: result };
        }
        const guard = async () => { await assertSafe(); await body.reflexGuard(); await assertSafe(); };
        if (route === "/browser/click") return host.click({ ...body, tabRef, reflexGuard: guard });
        if (route === "/browser/type") return host.type({ ...body, tabRef, reflexGuard: guard });
        if (route === "/browser/press" && body.key === "Enter") return host.press({ ...body, tabRef, reflexGuard: guard });
        throw new Error("unsupported_task_action");
      };
      return await runBrowserTask(value, { page, browser: host.browser(), tabRef, api, externalCheck, assertSafe, signal: taskSignal, mode });
    } catch (error) {
      return { status: taskSignal.aborted ? "cancelled" : "handoff", stopReason: error.code || error.message,
        elapsedMs: Math.round(performance.now() - started), operation: value.operation,
        contentSource: "browser_dom", contentUntrusted: true,
        snapshot: !taskSignal.aborted && page && !page.isClosed() ? await host.snapshot({ tabRef: host.ref(page), limit: 80 }).catch(() => null) : null };
    } finally { active = false; }
  }
  return { run, interrupt, active: () => active };
}
