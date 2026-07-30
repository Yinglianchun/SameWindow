# SameWindow 分体部署

[English](README.md)

把 SameWindow 的**浏览器半边**搬到你手边的机器上跑，**agent 半边**留在远端服务器——一条 SSH 反向隧道把两半缝起来。

## 先选本地浏览器

| 人身边的机器 | 推荐方案 |
| --- | --- |
| Windows 10 / 11 | [原生 Chrome + 透明双光标层](windows-native/README.zh-CN.md)——不需要 Docker、WSL 或 VNC |
| macOS / Linux | 下文的 Docker + Chromium + noVNC |
| 明确偏好容器隔离的 Windows 用户 | Docker 仍是受支持的可选方案 |

这个部署方式由 fable5 × ElianeClair 贡献，现在由
[SameWindow 官方仓库](https://github.com/Yinglianchun/SameWindow)
共同维护。它改变的是窗口住在哪里，不改变谁在共享它。

Issue #4 和这份贡献给了我们架构上最重要的启发：画面应该留在人身边，
只有很小的 agent 指令需要跨过网络。之后我们把 Windows 原生实现设为
Windows 默认，是因为在桌面窗口和透明光标之间再夹一层 Docker/WSL，
会增加冷启动、资源占用和坐标换算复杂度。Docker 不是被弃用的旧路；
它仍然是更便携、隔离更完整的跨平台选择。

## 为什么

SameWindow 默认全套跑在 VPS 上，人远程看画面。服务器离你近时这很完美；离你远时就塌了：VNC 传的是**画面帧**，每一帧都要在线路上跑一个来回——RTT 300 毫秒的线上，共享桌面恰好在你最想一起逛的时刻变成幻灯片。

解法是看清两半的需求相反：

- **画面**是重流量，该住在**人身边**——localhost、零延迟、晚高峰免疫；
- **agent 的指令**是几百字节的 CDP 调用，不在乎 300 毫秒——它可以跨洋。

```
你手边的机器 (笔记本/家里主机)                远端服务器
┌────────────────────────────────┐            ┌──────────────────────────┐
│ docker: Xvfb → Chromium(CDP)   │  ssh -R    │ agent (MCP 客户端)        │
│   x11vnc → noVNC :6080 ────────┼── 隧道 ────┤   SAMEWINDOW_CONTROL_URL │
│   control server :6081 ────────┼─→ :16081   │   = http://127.0.0.1:16081│
└──────────────┬─────────────────┘            └──────────────────────────┘
               │ localhost (零延迟)
        你的浏览器: http://127.0.0.1:6080/samewindow.html
```

你喜欢的一切都在分体后幸存：双光标、点击涟漪、"一起逛"开关、敏感页守卫。

## Docker 快速开始

前提：Docker（macOS 用 Docker Desktop 或 OrbStack——Apple Silicon 可用，镜像用的是 Debian 原生 arm64 的 Chromium），以及到你服务器的 SSH 密钥。

```bash
git clone https://github.com/Yinglianchun/SameWindow.git
cd SameWindow/split-deployment
docker compose up -d --build          # 首次构建需要几分钟
```

打开 <http://127.0.0.1:6080/samewindow.html> ——共享桌面，以你屏幕自己的帧率运行。

然后把 control API 递给你的服务器：

```bash
# 先编辑 tunnel.sh 里的 SERVER= 和 PORT=
chmod +x tunnel.sh && ./tunnel.sh     # 沉默即成功；保持它运行
```

服务器上，把本地隧道设为首选浏览器，把原来的 VPS 浏览器留作手动备用：

```bash
SAMEWINDOW_CONTROL_URL=http://127.0.0.1:16081
SAMEWINDOW_LIFECYCLE_URL=
SAMEWINDOW_FALLBACK_CONTROL_URL=http://127.0.0.1:6081
SAMEWINDOW_FALLBACK_LIFECYCLE_URL=http://127.0.0.1:6082
```

本地在线时，普通浏览器工具直接使用本地 Chrome。本地电脑睡着、VPS
浏览器也没开时，普通工具只会明确报错，**不会偷偷唤醒任何东西**。agent
必须先显式调用 `shared_browser_lifecycle_start`，SameWindow 才会启动
VPS 备用浏览器。临时 ref 会标成 `local:` / `vps:`；例如快照范围 ref
`s42:e1` 会变成 `local:s42:e1`，不会被误用到另一扇 Chrome。

把这些变量放进 `mcp_server.py` 的运行环境；如果使用已安装的 HTTP MCP
服务，就写进 `/etc/samewindow.env`。隧道的 macOS 开机自启见
`launchd.example.plist`；Linux 用 autossh 或 systemd user unit。

## 隐私出口（可选，推荐开启）

浏览器搬回家，改变的是"谁能看到你的 IP"：原布局里网站看到的是**服务器的** IP；裸跑本地浏览器，网站看到的就是**你家的** IP。想保住原有性质：`tunnel.sh` 顺带开了一条本地 SOCKS（`-D 1080`），把 `docker-compose.yml` 里的 `SAMEWINDOW_PROXY` 取消注释，网页流量就重新从你的服务器出去。如果你在意自己的 IP，请把这一步当作标准流程，而不是可有可无的附加项。

浏览器会关闭 DNS 预取和 QUIC，网页域名由 SOCKS5 在服务器侧解析，不再
使用 Chromium 会弹警告的旧 resolver-rule 参数。

暴露面一览——给你核对用的，不需要凭信任：

| 谁可能看到 IP | 代理开（推荐） | 代理关 |
| --- | --- | --- |
| **你的 AI 服务商（Anthropic/OpenAI…）** | **服务器 IP——agent 没搬过家** | **服务器 IP——agent 没搬过家** |
| 你逛的网站 | 服务器 IP | **你家 IP** |
| DNS 解析方 | 经服务器（强制走代理） | **你本地网络的 DNS** |
| WebRTC / STUN | 禁止绕行（两种模式都禁） | 禁止绕行 |
| 你自己的服务器 | 你家 IP（那是你自己的机器） | 同 |
| 你的宽带运营商 | 只见"连着自己的服务器"，内容加密 | 能看到你在逛哪些域名 |

### AI 服务商永远看不到你家 IP

值得单独立一个标题，因为对很多人来说，**这才是真正要命的那个 IP**。在分体部署里 agent 半边从未搬家：所有对 LLM 服务商（Anthropic、OpenAI……）的调用仍然从你的**服务器**发出，和分体之前一模一样——代理开或关都是如此。你家 IP 进不了 AI 侧的流量，因为 agent 根本不在这台机器上。

这也是"分体"优于"整套搬回家"的实际理由：把 agent 搬到本地跑，服务商看到的就变成了你的本地网络——对账号地区敏感的服务商而言，这是真实的风险。分体方案把浏览器放到你身边，而把账号留在它原来的地方。

亲眼验证：在共享浏览器里打开 `ipify.org`——它必须显示服务器的 IP，而不是你家的。画面永远不经代理——两种模式下帧都只走 localhost。

注意：代理开启时，隧道没在跑网页就打不开。

## 加固

隧道钥匙只需要转发权。在服务器的 `~/.ssh/authorized_keys` 里给它上限制：

```
restrict,port-forwarding,permitlisten="16081" ssh-ed25519 AAAA... you@machine
```

这样笔记本被偷，这把钥匙也开不了 shell。两台机器上所有容器端口都只绑 127.0.0.1，没有任何东西面向公网。

## 疑难杂症

- **Chromium 反复报 "profile in use by another computer"** ——非干净关机留下的残锁。容器启动时会自动清掉；其他场景撞见：删掉 profile 目录里的 `Singleton*`。
- **桌面正常但网页打不开**——代理开着而隧道没在跑。启动 `tunnel.sh`（或注释掉 `SAMEWINDOW_PROXY`）。
- **合盖=桌面睡觉**——隧道断开、醒来自动重连；期间 agent 的探测会温和地失败。这是有意的设计。
- **验证面具**：在共享浏览器里打开 `ipify.org` ——它应该显示你服务器的 IP，而不是你家的。

## 致谢与许可

- SameWindow —— 小雨 × Haven（[官方仓库](https://github.com/Yinglianchun/SameWindow)）。向别人分享原项目时，请直接发官方仓库的链接。
- Split deployment & docs: Fable 5
- 手动备用路由与上游整合：小雨 × Haven
- 许可：与上游一致 —— [SameWindow Noncommercial Share-Alike License 1.0](../LICENSE)。
