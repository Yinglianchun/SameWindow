# SameWindow Windows 原生模式

[English](README.md)

如果人类这一端使用 Windows，这是我们优先推荐的分体部署方式。

它直接在 Windows 上运行一扇独立 Chrome、SameWindow control server 和
原生透明双光标层。agent 仍然可以住在远端服务器；跨过 SSH 反向隧道的
只有很小的控制请求，真正的浏览器窗口一直留在你眼前。

不需要 Docker，不需要 WSL，不需要 VNC，也不需要安装浏览器扩展。

![SameWindow 原生 Chrome 中的人类与 agent 双鼠标](../../docs/images/windows-native-dual-cursor.jpg)

```text
Windows 电脑                                     远端服务器
┌────────────────────────────────────┐           ┌──────────────────────┐
│ 独立 Chrome + 持久登录 profile      │           │ agent + SameWindow  │
│ Windows 原生透明双光标层             │  ssh -R   │ MCP                  │
│ control :6081 / lifecycle :6084 ───┼──────────→│ :16081 / :16082      │
└────────────────────────────────────┘           └──────────────────────┘
               画面始终留在本地
```

## 为什么 Windows 优先用这一版

[Issue #4](https://github.com/Yinglianchun/SameWindow/issues/4) 和
fable5 × ElianeClair 提交的分体部署给了我们最重要的启发：
**画面没有必要陪 agent 一起跨洋。** 窗口留在人身边，agent 留在它原本
生活的服务器上就好。

他们实现的 Docker 版本仍然很有价值：它适合 macOS、Linux，也适合明确
想要容器隔离的人。但在 Windows 上，Docker/WSL 会多出一整层运行时、
更慢的冷启动，以及宿主窗口和容器桌面之间更复杂的坐标换算。

所以我们没有撤掉 Docker，而是沿着同一个“分体”想法，给 Windows 做了
一条更短的路：

- 直接使用现有 Chrome 或 Edge，但放进独立且持久的登录目录；
- Node.js control/lifecycle 服务原生运行；
- 小狐狸入口拉起一层可穿透点击的 Windows 透明双光标；
- 切换标签、新开页面、`chrome://` 页面时仍能跟住当前窗口；
- 人类白鼠标和 agent 黑鼠标都不需要注入网页；
- 需要时可通过同一条 SSH 隧道，让网页继续从 VPS 的 IP 出口访问。

Docker 方案没有弃用，也不会撤掉。它继续作为跨平台可选项维护，见
[分体部署总览](../README.zh-CN.md)。

## 需要什么

- Windows 10 / 11
- Node.js 20+
- Google Chrome 或 Microsoft Edge
- Windows OpenSSH Client
- 一把能登录远端服务器的 SSH 密钥
- PowerShell 5.1（Windows 自带）

本机所有端口只绑定 `127.0.0.1`。

## 第一次配置

在仓库根目录执行：

```powershell
cd split-deployment\windows-native
Copy-Item settings.example.json settings.json
notepad settings.json
```

至少填上 SSH 目标：

```json
{
  "server": "your-user@your-server"
}
```

常用设置：

| 字段 | 用途 |
| --- | --- |
| `server` | SSH 目标 |
| `sshPort` | SSH 端口，默认 `22` |
| `identityFile` | 可选密钥路径；留空使用 `%USERPROFILE%\.ssh\id_ed25519` |
| `privacyExit` | `vps` 让网页从服务器出口访问；`local` 使用本机网络 |
| `chromePath` | 可选，手动指定 Chrome / Edge |
| `homeUrl` | 独立浏览器第一次打开的页面 |

一键启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1
```

首次运行如果缺少依赖，会安装仓库声明的 `playwright-core`。登录信息只
保存在 `split-deployment/windows-native/data/chrome-profile`，停止后
不会丢。

只关浏览器、保留 profile：

```powershell
.\stop.ps1
```

连 lifecycle 和 SSH 隧道也一起关：

```powershell
.\stop.ps1 -All
```

## 远端服务器怎么接

给运行 `src/mcp_server.py` 的环境配置：

```bash
SAMEWINDOW_CONTROL_URL=http://127.0.0.1:16081
SAMEWINDOW_LIFECYCLE_URL=http://127.0.0.1:16082
SAMEWINDOW_FALLBACK_CONTROL_URL=http://127.0.0.1:6081
SAMEWINDOW_FALLBACK_LIFECYCLE_URL=http://127.0.0.1:6082
```

Windows 隧道在线时，MCP 优先使用本地这扇 Chrome。原来的 VPS 浏览器
只做手动备用：普通工具不会偷偷唤醒它；只有显式调用
`shared_browser_lifecycle_start` 才会启动备用窗口。

如果你根本不保留 VPS 浏览器，删掉两个 `FALLBACK` 变量即可。

## 隐私出口

默认 `privacyExit` 是 `vps`。`tunnel.ps1` 会在本机开
`127.0.0.1:1080` SOCKS5，独立 Chrome 通过它访问网页。网站和 DNS
看到的是服务器出口，不是家庭网络；同时关闭 QUIC、DNS 预取和绕过
代理的 WebRTC UDP。

代价是隧道不在线时网页也打不开。不需要这层性质时，把它改成
`local`。

## 常见问题

- **网页打不开**：如果 `privacyExit` 是 `vps`，确认 `tunnel.ps1`
  正在运行，并且服务器允许 TCP forwarding。
- **切标签后透明层没跟上**：确认这扇 Chrome 是由 `launch.ps1`
  启动的；日常私人 Chrome 会被故意忽略。
- **端口被占用**：关掉占用 `6081`、`6084` 或 `9222` 的旧
  SameWindow / split-browser 进程。
- **弹出 `rdclientax.dll` / 远程桌面 ActiveX 错误**：这是损坏的 WSLg
  在拉起 `msrdc.exe`，与 SameWindow 原生模式无关。关闭对应 WSL
  进程或修复 WSL 即可；本方案不会调用 WSL 或远程桌面。

## 致谢

Windows 原生模式由小雨 × Haven 维护。它的架构来自 issue #4 的讨论，
也受 fable5 × ElianeClair 的 Docker 分体贡献启发。两种方案都会继续
留在 SameWindow 里。
