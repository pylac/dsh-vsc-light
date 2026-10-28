# dsh-vsc-light

[English](README.md) | 中文

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 界面嵌入 Windows 上的 VS Code 编辑面板，让你在代码旁边直接和 agent 协作，不必在编辑器与浏览器之间来回切换。

## 功能

- **编辑器区域内的面板** —— DSH 以编辑器标签页的形式开在代码旁边，而不是另开一个浏览器窗口。切换标签页时面板状态会保留，正在流式输出的回复不会被打断。
- **一键引用代码** —— `Ctrl+Alt+K` 复制光标所在行的**绝对路径**引用 `@C:\项目\src\app.ts:42`；选中多行时复制区间 `:42-58`。绝对路径在各种工作区布局下都能解析——相对路径依赖一个 DSH 并不存在的"工作区根"概念。
- **自动管理服务生命周期** —— 首次打开面板时启动 DSH，关闭面板后服务继续运行（再次打开即时可用），退出 VS Code 时自动清理。
- **重载窗口后自动恢复** —— 添加工作区文件夹、安装扩展都会重启扩展主机（DSH 也随之重启）。面板会自己回来并重新走启动流程，而不是停在"重新连接中"。
- **零配置** —— 自动探测 `dsh` 入口与 Node.js 可执行文件；安装位置不标准时两者都可以手动指定。
- **链接用系统浏览器打开** —— 点击回复里的链接会在默认浏览器中打开，而不是毫无反应。
- **失败可恢复** —— 服务意外退出时面板会显示错误和「重试」按钮，而不是变成一片空白。
- **跟随编辑器语言** —— 面板的通知、按钮和错误文案跟随 VS Code 的显示语言（内置英文与简体中文，英文为回退）。切换显示语言后需重载窗口生效。

## 前置条件

| | |
|---|---|
| VS Code | **1.85.0** 或更高版本 |
| 操作系统 | **Windows 10 或 11** —— 本扩展仅支持 Windows |
| Node.js | **20** 或更高版本，需要系统级安装 |
| DeepSeek Harness | 已全局安装 `dsh` CLI |

扩展只支持 Windows：它从 Windows 注册表构造 DSH 的环境，并用 `taskkill` 结束进程。扩展声明了 `os: ["win32"]`，其他平台在应用市场里会拒绝安装。

有两个容易踩的坑：

- **扩展使用的是系统 Node.js，不是 VS Code 内置的运行时。** VS Code 内嵌的是 Electron，其 Node 构建缺少 DSH 需要的部分命令行参数。请正常安装 Node.js，并确保 `node` 在 `PATH` 中。
- **扩展始终在本地运行。** 它会在你的机器上启动进程并监听本地回环端口，因此声明了 `extensionKind: ["ui"]` —— 即使工作区在远端，扩展也留在本机。

## 安装

先全局安装 `dsh` CLI：

```bash
npm install -g @deepseek-ai/dsh
```

再安装扩展：

- **VSIX** —— 下载 `.vsix` 后执行 `code --install-extension dsh-vsc-light-<版本>.vsix`，或在命令面板中使用 **Extensions: Install from VSIX…**。
- **从源码构建** —— 见[开发](#开发)。

## 使用

1. 用 `Ctrl+Alt+D`、编辑器标题栏的 DSH 图标，或命令面板的 **DSH: 显示/隐藏面板** 打开面板。首次运行需要几秒钟启动并完成认证，期间会显示一个带「取消」按钮的进度提示。
2. 与 agent 对话。面板通过本地连接与服务通信，不会向网络暴露任何东西。
3. 想让 agent 看某一行，把光标放在那里按 `Ctrl+Alt+K`，然后粘贴进对话。先选中多行再按，就会复制整段区间（`:42-58`）；选区终点落在下一行行首时，那一行不计入。路径是绝对路径，所以在任何工作区布局下解析结果都一样。
4. 关闭面板不会停止服务。需要关掉时用 **DSH: 停止服务**，就地重启用 **DSH: 重启服务**。

服务运行时状态栏会出现一个指示器，点击可切换面板。

## 命令

| 命令 | 默认快捷键 | 说明 |
|---|---|---|
| `DSH: 显示/隐藏面板` | `Ctrl+Alt+D` | 打开或关闭 DSH 面板。 |
| `DSH: 引用当前代码位置` | `Ctrl+Alt+K` | 复制光标所在行的绝对路径引用 `@文件:行号`；选中多行时复制区间 `@文件:起始行-结束行`。仅在文本编辑器获得焦点时生效。 |
| `DSH: 停止服务` | | 停止后台的 DSH 进程与本地代理。 |
| `DSH: 重启服务` | | 停止后重新启动。修改路径设置后可用。 |
| `DSH: 查看日志` | | 打开 **DSH** 输出通道。 |
| `DSH: 复制诊断信息` | | 复制一份脱敏报告：版本、探测到的路径、启动参数、服务与代理状态、环境来源、最近一次错误，可直接用于提 issue。路径中的用户主目录会替换为 `%USERPROFILE%`。 |

DSH 面板获得焦点时，「重启服务」与「停止服务」也会出现在面板标题栏。

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `dsh.binPath` | `""` | `@deepseek-ai/dsh` 的 `lib/bin.js` 绝对路径。留空则自动探测。 |
| `dsh.nodePath` | `""` | 系统 Node.js 可执行文件的绝对路径。留空则自动探测。 |
| `dsh.args` | `["--profile", "web", "--no-open"]` | 传递给 `dsh` 的参数。其中写的任何 `--port` 都会被扩展覆盖。 |

修改 `dsh.binPath` 或 `dsh.nodePath` **立即生效** —— 缓存的探测结果会被丢弃，不需要重载窗口。

## 工作原理

扩展会启动两样东西：

1. **`dsh` 进程**，端口由扩展自行挑选并通过 `--port` 传入。
2. **一个反向代理**，跑在扩展宿主内，监听一个随机的本地回环端口。

面板是一个 webview，里面用一个 `<iframe>` 指向该代理。之所以需要代理，是因为 iframe 是一个全新会话、没有 DSH 的凭据：代理负责注入认证 Cookie，改写 DSH 信任校验所需的 `Host`、`Origin`、`Referer` 头，并转发 WebSocket 升级请求，让流式回复能够工作。

有两点值得了解：

- **代理是「一个本地端口」与「一个已认证、能执行命令的 DSH 客户端」之间唯一的屏障。** 因此每个请求都必须通过三道校验：`Host` 必须指向代理自身（挡 DNS rebinding）、`Origin`/`Referer` 必须匹配（挡跨站网页），并且必须携带本会话的 256 位随机密钥（挡其他本机进程 —— 它们能伪造请求头，但猜不到密钥）。密钥每次会话重新生成，不会离开扩展宿主，代理停止时即作废。
- **扩展会向 DSH 页面注入一小段脚本。** DSH 把链接渲染成 `target="_blank"`，而 VS Code 的 webview 沙箱没有 `allow-popups`，这类点击会被浏览器直接拒绝、看起来毫无反应。注入的脚本把 URL 经面板递回扩展，由 `vscode.env.openExternal` 打开。只放行 `http`、`https`、`mailto`；`file:` 等其他 scheme 一律拒绝，因为 DSH 的回复是模型生成的，不能让它有能力打开本地文件。

### DSH 子进程的环境

`dsh` 进程的环境按「机器」构造，不继承 VS Code 进程：

| 步骤 | 来源 |
|---|---|
| 1 | 从父进程读取的操作系统身份变量（`SystemRoot`、`USERPROFILE`、`APPDATA`、`TEMP`、处理器信息等）——注册表里没有它们的副本 |
| 2 | 机器级环境：`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` |
| 3 | 用户级环境：`HKCU\Environment`，覆盖机器级同名项 |
| 4 | `PATH` = 机器 `PATH` + `;` + 用户 `PATH`，展开、去重、保持顺序 |

其余变量从设计上就不存在：`ELECTRON_*`、`VSCODE_*`、会话级 `DSH_*`、`VIRTUAL_ENV`/`CONDA_*`，以及只是在启动 VS Code 的那个终端里临时设过的东西。

**本扩展从不向 `PATH` 追加目录。** 如果 `code`、`python` 或 JVM 不在你的机器/用户 `PATH` 上，agent 就是找不到它。这是机器环境配置的问题，不是扩展的职责——一个工具一个工具地补永远补不完。

读不到注册表时（PowerShell 不可用、被策略禁用等），扩展降级为「身份变量 + 父进程 `PATH`」并写一条警告，绝不静默全量继承——那会让"这个变量从哪来"重新变得不可解释。探测失败不会被缓存，下次启动会再试一次。走了哪条路在输出通道里看得到：`[ENV] source=registry (machine N entries, user M entries)…`。

## 扩展对 DSH 做了什么

把 Web 应用塞进 iframe 不是透明操作，所以这里完整列出扩展碰过的每一处。DSH 升级后请对照这张表检查——最后一列写的是每一行依赖的 DSH 行为。

| 接触点 | 具体改动 | 为什么必须 | 依赖 DSH 的什么 |
|---|---|---|---|
| 启动参数 | 注入 `--port`；默认 `--profile web --no-open`；对 `--public-url` / TLS 参数只警告不阻止 | 面板必须连到自己选的端口、且是本地 http 监听 | `--profile web`、`--no-open`、`--port`，以及启动时打印的 `dsh web: …?token=…` |
| 环境变量 | 按机器环境构造而不是继承父进程；不向 `PATH` 追加任何目录 | 从 VS Code 启动的 DSH 不能带上 VS Code 或终端的变量 | DSH 从机器环境解析自己的工具链 |
| 代理·请求方向 | 改写 `Host`、`Origin`、`Referer`；用 DSH 的会话 Cookie 替换 `Cookie`；文档请求强制 `Accept-Encoding: identity` | DSH 的 Host/Origin 围栏拒绝外来源，而 iframe 自己没有凭据 | `/api` 围栏与基于 Cookie 的会话 |
| 代理·响应方向 | 只丢 `dsh-auth-*` Cookie；注入的文档上删 CSP 与 `X-Frame-Options`，重算 `Content-Length`、丢弃 `ETag` | DSH 的 Cookie 不该落进 webview；正文被改写后旧长度和哈希都失效 | index 文档是 `text/html`、未压缩、含 `</body>` |
| 页面注入 | `</body>` 前一段 `<script>`：上报 `dsh-ready`、拦截 `http`/`https`/`mailto` 链接点击、包装 `navigator.clipboard.writeText` | webview 沙箱没有 popup，跨源 iframe 也写不了剪贴板 | DSH 用 `target="_blank"` 渲染链接、用剪贴板 API 复制 |
| 容器 | iframe 带 `allow="clipboard-write; clipboard-read"`，CSP `frame-src` 只放行代理源 | 给被嵌入页面最小的权限 | — |

**明确不做**：不写 `DSH_HOME`、不改 DSH 的配置或 profile、不装插件、不改 `PATH`、不碰 DSH 的会话日志；扩展停用时会杀掉子进程。

## 故障排查

**要报告问题**

先执行 **`DSH: 复制诊断信息`**，把结果附上。里面有版本号、扩展探测到的路径、实际生效的启动参数、服务与代理是否在运行、子进程环境的来源，以及最近一次错误——通常足以直接定位原因，不用再来回追问。报告不包含任何环境变量的值、token 或对话内容。

**面板显示以 `DSH proxy rejected the request:` 开头的消息**

消息里会写明是哪道校验失败。`session` 表示会话 Cookie 未被接受；`origin` 或 `host` 表示请求不是来自面板。正常使用下不应出现 —— 请带上完整消息[提一个 issue](https://github.com/pylac/dsh-vsc-light/issues)。

**"Could not find the @deepseek-ai/dsh entry point"**

扩展找不到全局安装的 `dsh`。确认 `npm install -g @deepseek-ai/dsh` 成功，然后在错误提示上点 **打开设置** 填写 `dsh.binPath`，或自己查出路径：

```bash
npm root -g          # 在其后追加 /@deepseek-ai/dsh/lib/bin.js
```

**"Could not find the system node executable"**

Node.js 不在 `PATH` 中。安装它，或把 `dsh.nodePath` 设为 `node` 可执行文件的完整路径。

**面板一直空白，或服务起不来**

打开 **DSH** 输出通道（**DSH: 查看日志**）。里面有 `dsh` 进程捕获的 `stdout` 与 `stderr` —— 真正的原因通常就在那里。

**面板提示服务已退出**

`dsh` 进程挂了。点击面板里的 **重试**，或执行 **DSH: 重启服务**。具体原因在输出通道里。

**连到远程机器、WSL 或容器时完全不可用**

扩展是刻意只在本机运行的（见[前置条件](#前置条件)）。即使你连接的是远端工作区，面板也应当跑在你自己的机器上；如果并非如此，请提 issue。

## 开发

```bash
npm ci                # 安装依赖（按 lock 文件锁定）
npm run compile       # 编译 TypeScript 到 out/
npm run watch         # 监听变更并编译
npm run clean         # 删除 out/ —— 移动或删除源文件后要跑一次
npm run lint          # ESLint
npm run package       # 生成 dsh-vsc-light-<版本>.vsix（vscode:prepublish 会先编译）
npm run package:list  # 列出会被打包的文件
```

在 VS Code 中按 `F5` 会启动一个加载了本扩展的扩展开发宿主。

`tsc` 不会删除过期产物。移动、改名或删除源文件后，先跑 `npm run clean` 再编译：旧的 `out/…js` 仍留在磁盘上，而 Node 解析时文件优先于同名目录，它可能遮蔽替换掉它的那个模块。

项目没有自动化测试。依赖具体机器的故障从 **DSH** 输出通道定位（`DSH: 查看日志`）：那里记录了探测到的路径、实际生效的启动参数、子进程环境来自注册表还是降级，以及 `dsh` 进程的 `stdout` / `stderr`。

`.vscodeignore` 是**排除**表而不是白名单：仓库根目录下任何新出现的目录都会被塞进 VSIX，除非显式写在里面。打包前用 `npm run package:list` 看一眼清单。

## 许可证

[MIT](LICENSE)
