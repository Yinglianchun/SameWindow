# Optional quick browser tasks / 可选快速浏览任务

When the agent operates while the person watches, repeated snapshot → model →
click → snapshot calls add round trips. `shared_browser_task` lets a small decision
adapter choose several approved navigation actions inside one controller call.
The controller verifies arrival and returns a fresh real DOM snapshot with text,
links, snapshot-scoped refs, phase evidence, actions and millisecond timings.
Jev chooses actions; it does not summarize or filter the final page.

人看着、AI 操作时，可以一次交给它一个有限任务，减少逐步调用。
Jev 负责从当前允许的动作中选择；到达后由浏览器抓取真实正文和链接返回。

## Enable explicitly / 显式启用

Quick tasks require Node.js 20.3+ for combined cancellation signals.

Defaults are unchanged: 14 public tools, no task-provider calls. On the **browser
controller host**, configure its process environment (Linux: `/etc/samewindow.env`;
Windows: the environment inherited by the native lifecycle; Docker: container
environment). Keep credentials outside Git:

```dotenv
SAMEWINDOW_TASK_MODE=bounded
SAMEWINDOW_JEV_API_KEY=YOUR_KEY
```

On the **MCP host**, enable the new tool:

```dotenv
SAMEWINDOW_ENABLE_TASKS=1
```

Restart the affected processes. HTTP installations use `samewindow-control.service`
and `samewindow-mcp.service`; stdio clients launch their own MCP process, so configure
its environment too. Windows helpers inherit environment when launched: close and
restart the native browser group using its scripts after changing configuration.
Do not put a controller credential in agent prompts or tool arguments.

分体部署时，密钥和任务模式配置在浏览器那台机器，工具开关配置在 MCP 那台机器。
修改后重启对应进程。Windows 配置需要在启动原生浏览器脚本前设置好。

The first adapter uses Jev `jev-1.13.0` at the fixed Typesafe endpoint. Enabling it
sends the approved search text, minimal task controls and public account/pin
identity evidence to that external service. Home timeline and full final-page
snapshots are not sent to it. API credentials stay controller-side. Provider
receipts must name an offered candidate; arbitrary generated actions/URLs are
never executed. The internal `decide` adapter is isolated for replacement and
offline testing; no arbitrary provider URL or executable action is accepted in MCP.

启用意味着同意把搜索文字、任务控件和公开账号/置顶线索发给 Jev 服务。
完整最终页面由浏览器返回给调用方，不额外交给 Jev 筛选。

## Supported tasks / 当前支持

Open X, sign in manually, then call:

```json
{"operation":"x_search","text":"your search","tab_ref":"tab-1"}
```

```json
{"operation":"x_profile_pinned","text":"Exact display nickname","tab_ref":"tab-1"}
```

The optional `tab_ref` pins that tab; without it the controller reuses an existing
X tab. It never replaces an unrelated tab or starts a sleeping backend. Search
starts at X Home, uses observed controls, then verifies loaded results. Profile
tasks search People, require one exact nickname/account link, verify its header,
then open an observed pinned post owned by that account. No account binding or
guessed handles. Duplicate nicknames return `ambiguous_nickname`. If a loaded
profile top has posts but no pin, report `no_pinned_post_visible_at_profile_top`;
this is a visible-page finding, not an assertion about hidden/unloaded content.
Initial adapters expect X's English search controls (People/Top also accept the
included Chinese labels). Other site/layout variants return handoff.

先手动打开 X 并登录。可以搜索原文，或按准确昵称寻找主页并查看置顶。
同名账号不会猜；没有看到置顶，会返回这一有限的页面观察结果。

Each phase has at most five decision cycles and 20 seconds; the controller's total
deadline is 55 seconds including setup and MCP timeout is 65 seconds. WAIT/stale
decisions consume the same budget. One active task pins a backend/tab and never
switches backend during a disconnect. Another controller action, native tab change
or mouse down inside the shared viewport interrupts it. Geometry/unchanged-tab
heartbeats and clicks outside the viewport do not. Keyboard takeover detection is
not comprehensive. Sensitive-page and form checks run before DOM reads/provider
requests and input, using the existing SameWindow guards. Unknown/invalid choices,
uncertain input, missing controls, deadlines or user takeover stop the task. Failed
input is not retried. No publishing, likes, follows, replies, messages or purchases.

每阶段最多五次决策、20 秒。用户接手、敏感页面、页面失效或超时就停下来。
键盘接手检测仍有限。此功能只找路和读取，不发布、不点赞、不关注。

## Optional compact tools / 可选精简工具

With tasks enabled, set `SAMEWINDOW_COMPACT_TOOLS=1` on the MCP host to expose eight
tools: lifecycle status/start/stop, browser status/tabs/open/snapshot/task. The old
select/close/click/type/press/social_feed/social_read implementations remain intact;
set the flag back to `0` and restart MCP to expose them again. Task-enabled full
mode has 15 tools. Browse-together's existing opt-in adds two tools to either mode.
Compact mode without task exposure fails configuration validation. Clients may
need a tool-list/connection refresh after registration changes; there is no runtime
client refresh guarantee or hidden tool-toggle command.

精简模式只改变注册列表，旧实现仍保留；关闭该配置并重启 MCP 即可恢复。
客户端可能还需要刷新连接，旧聊天不保证马上拿到新工具表。

## Validation

`npm run check`, `python tests/router_test.py`, `python tests/mcp_smoke.py`.
Browser integration tests intercept X with isolated Chrome fixtures and an offline
decision adapter; no live accounts, credentials, API spend or real posts are used.
Coverage includes search, pin/no-pin, ambiguous identities, sidebar exclusion,
snapshot refs, sensitive routes/forms, native observation heartbeats, outside
clicks, user takeover, default-off/missing credentials and bounded-loop failure
conditions. Real-site behavior remains subject to X UI changes; this public PR
does not claim a generic natural-language browser agent or a guaranteed latency.
