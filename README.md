# dsh-vsc-light

English | [中文](README.zh.md)

Runs the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web UI inside a VS Code editor panel on Windows, so you can work with the agent next to your code instead of switching to a browser window.

## Features

- **Panel in the editor area** — DSH opens beside your code in an editor tab, not in a separate browser window. The panel keeps its state when you switch tabs, so a streaming reply is not interrupted.
- **Reference code in one keystroke** — `Ctrl+Alt+K` copies an absolute `@C:\project\src\app.ts:42` reference for the cursor line, or `:42-58` when you select several lines. Absolute paths stay correct in multi-root workspaces and in any session workspace, where a relative path would depend on a "workspace root" DSH does not have.
- **Automatic service lifecycle** — DSH starts when you first open the panel, keeps running when you close it (so reopening is instant), and is cleaned up when VS Code exits.
- **Survives a window reload** — adding a workspace folder or installing an extension restarts the extension host (and with it DSH). The panel comes back by itself and reruns the startup instead of sitting on a "reconnecting" page.
- **Zero configuration** — the `dsh` entry point and the Node.js executable are detected automatically. Both can be overridden when your setup is non-standard.
- **Links open in your browser** — clicking a link in a reply opens it in your default browser instead of doing nothing.
- **Recoverable failures** — if the service dies, the panel shows an error with a Retry button rather than going blank.
- **Speaks your editor's language** — the panel's notifications, buttons, and error copy follow the VS Code display language (English and Simplified Chinese are included; English is the fallback). Switching the display language takes effect after a window reload.

## Requirements

| | |
|---|---|
| VS Code | **1.85.0** or newer |
| Operating system | **Windows 10 or 11** — the extension is Windows-only |
| Node.js | **20** or newer, installed system-wide |
| DeepSeek Harness | the `dsh` CLI, installed globally |

The extension is Windows-only because it builds the DSH environment from the Windows registry and stops DSH with `taskkill`. It is declared `os: ["win32"]`, so the Marketplace refuses to install it elsewhere.

Two details are easy to get wrong:

- **The extension uses a system Node.js, not the runtime bundled with VS Code.** VS Code embeds Electron, whose Node build lacks some CLI flags DSH needs. Install Node.js normally and make sure `node` is on your `PATH`.
- **The extension always runs locally.** It starts a process on your machine and listens on a loopback port, so it is declared `extensionKind: ["ui"]` and stays on your local machine even when the workspace is remote.

## Installation

Install the `dsh` CLI globally first:

```bash
npm install -g @deepseek-ai/dsh
```

Then install the extension:

- **VSIX** — download a `.vsix` and run `code --install-extension dsh-vsc-light-<version>.vsix`, or use **Extensions: Install from VSIX…** in the Command Palette.
- **From source** — see [Development](#development).

## Usage

1. Open the panel with `Ctrl+Alt+D`, the DSH icon in the editor title bar, or **DSH: Show/Hide Panel** from the Command Palette. The first run takes a few seconds while the service starts and authenticates; a progress notification with a Cancel button appears while it does.
2. Chat with the agent. The panel talks to the service over a local connection; nothing is exposed to your network.
3. To point the agent at a line, put the cursor there and press `Ctrl+Alt+K`, then paste into the chat. Select several lines first to reference the whole range (`…:42-58`); a selection ending at the start of a line does not count that line. The path is absolute, so it resolves the same in every workspace layout.
4. Closing the panel leaves the service running. Use **DSH: Stop Service** to shut it down, or **DSH: Restart Service** to restart it in place.

A status bar indicator appears while the service is running; clicking it toggles the panel.

## Commands

| Command | Default keybinding | Description |
|---|---|---|
| `DSH: Show/Hide Panel` | `Ctrl+Alt+D` | Open or close the DSH panel. |
| `DSH: Reference Current Code Location` | `Ctrl+Alt+K` | Copy an absolute `@file:line`, or `@file:from-to` for a multi-line selection. Only active while a text editor has focus. |
| `DSH: Stop Service` | | Stop the background DSH process and the local proxy. |
| `DSH: Restart Service` | | Stop and start again. Useful after changing a path setting. |
| `DSH: Show Logs` | | Open the **DSH** output channel. |
| `DSH: Copy Diagnostics` | | Copy a redacted report — versions, resolved paths, launch arguments, service and proxy state, environment source, and the last error — for a bug report. The user-profile part of each path is replaced with `%USERPROFILE%`. |

Restart and Stop also appear in the panel's title bar while the DSH panel is focused.

## Settings

| Setting | Default | Description |
|---|---|---|
| `dsh.binPath` | `""` | Absolute path to `@deepseek-ai/dsh`'s `lib/bin.js`. Leave empty to detect it automatically. |
| `dsh.nodePath` | `""` | Absolute path to the system Node.js executable. Leave empty to detect it automatically. |
| `dsh.args` | `["--profile", "web", "--no-open"]` | Arguments passed to `dsh`. Any `--port` you put here is overridden by the extension. |

Changing `dsh.binPath` or `dsh.nodePath` takes effect immediately — the cached detection result is discarded, so you do not need to reload the window.

## How it works

The extension starts two things:

1. **The `dsh` process**, on a port it picks itself and passes via `--port`.
2. **A small reverse proxy** inside the extension host, on a random loopback port.

The panel is a webview containing an `<iframe>` pointed at that proxy. The proxy exists because the iframe is a fresh session with no DSH credentials: it injects the authentication cookie, rewrites the `Host`, `Origin` and `Referer` headers that DSH's trust checks require, and forwards WebSocket upgrades so streaming replies work.

Two consequences are worth knowing about:

- **The proxy is the only thing between a local port and a fully authenticated DSH client**, and DSH can run commands. Every request therefore has to pass three checks: the `Host` header must point at the proxy itself (blocks DNS rebinding), `Origin`/`Referer` must match (blocks cross-site web pages), and a 256-bit per-session secret must be presented as a cookie (blocks other local processes, which can forge headers but cannot guess the secret). The secret is generated per session, never leaves the extension host, and is invalidated when the proxy stops.
- **The extension injects a small script into the DSH page.** DSH renders links with `target="_blank"`, and VS Code's webview sandbox has no `allow-popups`, so such a click is rejected by the browser and appears to do nothing. The injected script hands the URL back through the panel to the extension, which opens it with `vscode.env.openExternal`. Only `http`, `https` and `mailto` are allowed — `file:` and other schemes are rejected, because DSH's replies are model-generated and must not be able to open local files.

### The environment of the spawned DSH process

The `dsh` process is started with an environment built from the machine, not from VS Code's process:

| Step | Source |
|---|---|
| 1 | OS identity variables read from the parent process (`SystemRoot`, `USERPROFILE`, `APPDATA`, `TEMP`, processor facts, …) — the registry has no copy of these |
| 2 | The machine environment: `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` |
| 3 | The user environment: `HKCU\Environment`, overriding machine values |
| 4 | `PATH` = machine `PATH` + `;` + user `PATH`, then expanded, deduplicated, order preserved |

Everything else is absent by construction: `ELECTRON_*`, `VSCODE_*`, session-scoped `DSH_*`, `VIRTUAL_ENV`/`CONDA_*`, and anything exported only in the terminal that happened to launch VS Code.

**This extension never adds directories to `PATH`.** If `code`, `python` or a JVM is not on your machine or user `PATH`, the agent will not find it. That is a machine configuration concern, not this extension's — adding one tool at a time would never end.

If the registry cannot be read (PowerShell unavailable, policy-blocked, …), the extension falls back to the identity variables plus the parent `PATH` and logs a warning. It never silently inherits everything, because that would make "where did this variable come from" unanswerable again. A failed probe is not cached — the next start tries again. The output channel shows which path was taken: `[ENV] source=registry (machine N entries, user M entries)…`.

## What the extension changes in DSH

Embedding a web app in an iframe is not transparent, so this is the complete list of what the extension touches. Review it after a DSH upgrade — the last column names the DSH behaviour each row depends on.

| Touch point | Change | Why it is required | DSH behaviour it relies on |
|---|---|---|---|
| Launch arguments | Adds `--port`; defaults to `--profile web --no-open`; warns (never blocks) on `--public-url` or TLS flags | The panel must reach the port it chose, over the local http listener | `--profile web`, `--no-open`, `--port`, and the printed `dsh web: …?token=…` line |
| Environment | Built from the machine instead of inherited; no directories added to `PATH` | A DSH started from VS Code must not carry VS Code's or a terminal's variables | DSH resolves its tools from the machine environment |
| Proxy, request side | Rewrites `Host`, `Origin`, `Referer`; replaces `Cookie` with DSH's session cookie; forces `Accept-Encoding: identity` on document requests | DSH's Host/Origin fence rejects a foreign origin, and the iframe has no credentials of its own | The `/api` fence and the cookie-based session |
| Proxy, response side | Drops only `dsh-auth-*` cookies; on injected documents drops CSP and `X-Frame-Options`, recomputes `Content-Length`, drops `ETag` | DSH's own cookie must not land in the webview, and a modified body invalidates the old length and hash | The index document is `text/html`, uncompressed, and contains `</body>` |
| Page injection | One `<script>` before `</body>`: announces `dsh-ready`, intercepts `http`/`https`/`mailto` link clicks, wraps `navigator.clipboard.writeText` | The webview sandbox has no popups, and a cross-origin iframe cannot write the clipboard | DSH renders links with `target="_blank"` and copies with the clipboard API |
| Webview container | iframe with `allow="clipboard-write; clipboard-read"`, CSP `frame-src` limited to the proxy origin | Minimal permissions for the embedded page | — |

What it deliberately does **not** do: it never writes to `DSH_HOME`, never edits DSH's configuration or profile, never installs plugins, never changes `PATH`, and never touches DSH's session logs. The child process is killed when the extension is deactivated.

## Troubleshooting

**Reporting a problem**

Run **`DSH: Copy Diagnostics`** and attach the result. It contains the versions, the paths the extension resolved, the effective launch arguments, whether the service and proxy are running, where the child environment came from, and the last error — which is usually enough to identify the cause without a follow-up round. The report contains no environment values, no tokens, and no conversation content.

**The panel shows a message starting with `DSH proxy rejected the request:`**

The message names the check that failed. `session` means the session cookie was not accepted; `origin` or `host` means the request did not come from the panel. This should not happen in normal use — please [open an issue](https://github.com/pylac/dsh-vsc-light/issues) with the full message.

**"Could not find the @deepseek-ai/dsh entry point"**

The extension could not locate a global `dsh` installation. Confirm `npm install -g @deepseek-ai/dsh` succeeded, then either press **Open Settings** on the error notification and set `dsh.binPath`, or find the path yourself:

```bash
npm root -g          # then append /@deepseek-ai/dsh/lib/bin.js
```

**"Could not find the system node executable"**

Node.js is not on `PATH`. Install it, or set `dsh.nodePath` to the full path of your `node` executable.

**The panel stays blank, or the service will not start**

Open the **DSH** output channel (**DSH: Show Logs**). It contains the captured `stdout` and `stderr` of the `dsh` process, which is where the actual cause usually is.

**The panel says the service exited**

The `dsh` process died. Click **Retry** in the panel, or run **DSH: Restart Service**. The output channel has the reason.

**Nothing works when connected to a remote machine, WSL, or a container**

The extension is deliberately local-only (see [Requirements](#requirements)). If you are connected to a remote workspace, the panel should still run on your own machine; if it does not, please open an issue.

## Development

```bash
npm ci                # install dependencies (pinned by the lock file)
npm run compile       # compile TypeScript to out/
npm run watch         # compile on change
npm run clean         # delete out/ — run it after moving or deleting a source file
npm run lint          # ESLint
npm run package       # build dsh-vsc-light-<version>.vsix (vscode:prepublish compiles first)
npm run package:list  # list the files that would be packaged
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

`tsc` never deletes stale output. After renaming, moving, or deleting a source file, run `npm run clean` before compiling: the old `out/…js` stays on disk and Node resolves a file before a directory, so it can shadow the module that replaced it.

There is no automated test suite. Failures that depend on a machine are diagnosed from the **DSH** output channel (`DSH: Show Logs`), which records the resolved paths, the effective launch arguments, whether the child environment came from the registry or degraded, and the captured `stdout` / `stderr` of the `dsh` process.

`.vscodeignore` is an **exclusion** list, not an allowlist: any new directory at the repository root ends up in the VSIX unless it is listed there. Run `npm run package:list` to see the packaged set before shipping.

## License

[MIT](LICENSE)
