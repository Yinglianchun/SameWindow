# Changelog / 更新日志

## 2026-09-11 — Browser reading and observation / 页面读取与观察

### 中文

- **元素定位：**从往 DOM 元素上贴临时属性，改为无障碍树 + DOM 布局信息 + 浏览器节点 ID。支持可访问名称和开放 Shadow DOM 控件；继续使用 `s42:e1` 快照编号，保留同标签旧编号失效、跨标签隔离、并发操作保护和遮挡快速报错。替换掉的节点不能用旧编号误点。
- **一起逛：**改用 `MutationObserver` 配合焦点和导航事件，空闲页面不再每秒扫描。保留 5 秒页面预览、15 秒正文窗口、变化后重新读取和文字去重；持续变化不会无限推迟读取。开关仍由人控制，默认关闭。
- **社交阅读：**新增默认 MCP 工具 `social_feed`、`social_read`，支持 X／小红书信息流、搜索、准确帖子和已加载讨论。复用连接及每个平台的专用标签页，保留最近三分钟的列表；按准确链接点卡片，读完在安全时返回。单次最多 30 张卡片、40 条讨论。
- **加载等待：**社交阅读在文字／卡片可读后继续，不等慢图片和脚本全部加载；滚动次数与等待时间有上限。不会改善本身的网络下载或 noVNC 传输。
- **边界与打包：**保留敏感页面拦截，并覆盖开放 Shadow DOM 内的敏感输入框；社交读取遇到登录、验证、错误目标或人类导航会停下。补齐 Docker 的新模块及上游 MIT 许可文件，默认 MCP 工具数从 12 个增加到 14 个，可选“一起逛”工具仍为 2 个。

没有新增社交发帖、评论或点赞工具；没有加入 JPEG 观看模式。公开仓库不包含私有聊天宿主或账号数据。阅读结果来自已加载页面，可能不完整；X 的 `thread` 不保证全是直接回复，站点变动也可能导致适配失效。这不是规避平台风控的承诺。

**验证范围：**Windows 上使用独立临时 Chrome 配置和本地模拟页面，验证了节点身份、同名按钮、Shadow DOM、过期编号、敏感表单、监听开关及文字更新；X／小红书验证了列表复用、准确卡片点击、详情、返回、慢脚本、目标消失、验证拦截和零社交写入。另检查 MCP 握手及分体部署路由。此次未在真实社交账号或 Linux 桌面上重新验收。

**升级：**先结束当前浏览器操作，在仓库执行 `git pull --ff-only`、`npm ci`。Ubuntu 安装方式需再次运行 `sudo ./scripts/install-ubuntu.sh`，然后重启运行中的 `samewindow-control.service` 和可选的 `samewindow-mcp.service`；SSH stdio 客户端重新连接即可。Windows 原生方式停止后按原启动方式重新启动；Docker 分体方式重新构建镜像并启动容器。专用 Chrome 配置目录继续保留，升级不需要重新导出登录态。重新连接 MCP 客户端后可见两个新工具；“一起逛”仍需人手动开启。

### English

- **Element references:** replace DOM reference attributes with accessibility information, DOM layout, and browser node IDs. Preserve snapshot-scoped refs, per-tab invalidation, action serialization, and fast obstruction errors. Accessible names and open shadow-root controls are supported; replaced nodes reject old refs.
- **Browse together:** observe mutations, navigation, and focus instead of scanning idle pages every second. Preserve five-second previews, fifteen-second text windows, changed-text capture, and deduplication. Continuous mutations do not defer capture forever. Observation remains human-controlled and off by default.
- **Social reading:** add `social_feed` and `social_read` for X and Xiaohongshu feeds, search, exact posts, and loaded discussion. Reuse the connection and a dedicated tab per platform; retain lists for three minutes, click matching permalinks, and return when safe. Limits are 30 cards and 40 discussion items.
- **Loading:** proceed when readable cards/text appear rather than waiting for slow images and scripts. Scrolling and waits are bounded. This does not accelerate network downloads or noVNC transport.
- **Safety and packaging:** retain sensitive-page guards and extend them to open shadow-root inputs. Stop on login, verification, missing/mismatched targets, and human navigation. Include the new module and upstream MIT notice in Docker. Default MCP tools increase from 12 to 14, with two browse-together tools still opt-in.

No social posting/commenting/liking tools or JPEG viewer are added. Private host
integrations and account data are not included. Loaded-page results can be
partial, X conversation items are not verified direct replies, and site changes
may require selector updates. These changes do not guarantee avoidance of
platform challenges.

**Validation:** disposable Chrome profiles and intercepted local platform
fixtures on Windows cover node identity, duplicate labels, shadow roots, stale
refs, sensitive forms, watch lifecycle/text updates, feed reuse, exact-card
reading, return navigation, stalled scripts, missing targets, challenges, and
zero social writes. MCP handshake and split-backend routing are also checked.
Real social accounts and the Linux desktop stack were not revalidated in this update.

**Upgrade:** finish active browser work, then run `git pull --ff-only` and
`npm ci` in the checkout. Ubuntu installations must rerun
`sudo ./scripts/install-ubuntu.sh`, then restart any running
`samewindow-control.service` and optional `samewindow-mcp.service`; SSH stdio
clients can reconnect. Stop/restart the Windows native setup using its existing
launcher, or rebuild/restart the split Docker container. Keep the dedicated
Chrome profile directory; no session export is needed. Reconnect the MCP client
to discover the new tools. Browse together still requires the person's toggle.

Social selectors and list/detail workflow are adapted from
[blueberriely/ai-social-browser](https://github.com/blueberriely/ai-social-browser)
at `44fc6b6`. Its [MIT notice](src/third-party/ai-social-browser.LICENSE) is retained.
