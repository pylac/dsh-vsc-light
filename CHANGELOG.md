# Change Log

This file describes the extension as it is at **1.0.0**.

## [1.0.0] - 2026-10-18

### What it does

- Embeds the DeepSeek Harness web UI in an editor panel beside your code, so a project can
  be developed and a DSH session driven from the same window.
- Starts `dsh --profile web --no-open --port <chosen>` on first use, keeps it running when
  the panel is closed, restarts it on demand, and kills it when the extension host exits.
  The service is a child process the extension owns; nothing else about DSH is changed.
- Reverse-proxies the panel's traffic on a random loopback port so the iframe can
  authenticate, stream replies, and open external links in the system browser.
- `Ctrl+Alt+K` copies an absolute `@path:line` reference for the cursor line, or
  `@path:from-to` for a multi-line selection. Paths containing spaces are quoted as
  `@"…"`; references are never relative, because DSH has a single session workspace and a
  VS Code multi-root workspace has several roots.
- Restores the panel automatically after a window reload (adding a workspace folder,
  installing an extension, …) by rerunning the start-and-authenticate flow.
- `DSH: Copy Diagnostics` copies a redacted report for bug reports — extension, VS Code,
  OS, Node and DSH versions; the resolved `dsh` entry and Node paths; the effective launch
  arguments; service and proxy state; where the child environment came from; the workspace
  shape; and the last error. The user-profile portion of every path becomes
  `%USERPROFILE%`, and no environment value, token, or conversation content is included.
  The same action is offered as a button on startup-failure notifications.

### Localization

- The panel's own copy — overlay text, notifications, dialog buttons, error summaries — follows
  the VS Code display language through `l10n/bundle.l10n.zh-cn.json`. English is the source
  language, and a missing key falls back to it. The page's `<html lang>` follows the same language.
- Code comments, output-channel logs, and error details are English, so that a bug report reads
  the same regardless of the reporter's display language.

### Environment of the `dsh` child process (Windows)

The child is launched with an environment built from the machine, not inherited from
VS Code: OS identity variables read from the parent (`SystemRoot`, `USERPROFILE`, `APPDATA`,
`TEMP`, processor facts, …), then the registry machine environment
(`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`), then the registry
user environment (`HKCU\Environment`), with `PATH` composed from the machine and user
entries, expanded and deduplicated.

- The extension **never adds directories to `PATH`**. A missing `code`, `python`, or JVM is
  a machine-configuration matter.
- `ELECTRON_*`, `VSCODE_*`, session-scoped `DSH_*`, `VIRTUAL_ENV`/`CONDA_*`, and variables
  exported only in the terminal that launched VS Code do not reach DSH.
- An unreadable registry degrades to the identity variables plus the parent `PATH`, with a
  warning in the output channel. Failures are not cached, so the next start retries.

### Security

- The proxy is the only thing between a local port and an authenticated DSH client, and DSH
  can run commands. Every request must present the proxy's own `Host`, a matching
  `Origin`/`Referer`, and a 256-bit per-session secret in a cookie. The secret never leaves
  the extension host and is discarded when the proxy stops.
- Externally opened links are limited to `http`, `https`, and `mailto`.
- The DSH startup token is masked as `token=***` in the output channel, in startup-failure
  dumps, and in the "Copy Error Details" clipboard action.
- Only `dsh-auth-*` cookies are stripped from upstream responses; other cookies pass
  through.

### Compatibility

- Verified against DSH `0.2.0-rc.2` and `0.2.1-rc.2`: the `--profile web`, `--no-open`, and
  `--port` flags, the printed `dsh web: …?token=…` line, the token-for-cookie exchange, the
  `/api` Host/Origin fence, and the shaped index document the panel is injected into.
- **Windows only.** The extension is declared `os: ["win32"]`: it builds the DSH environment
  from the Windows registry and stops DSH with `taskkill`, so the Marketplace refuses to
  install it on other platforms.
- Requires VS Code 1.85 or newer and a system Node.js 20 or newer.

### Development

- `npm run compile`, `npm run lint`, and `npm run package` (`vscode:prepublish` compiles first).
  There is no automated test suite: failures that depend on a machine are diagnosed from the
  **DSH** output channel, which records the resolved paths, the effective launch arguments,
  whether the child environment came from the registry or degraded, and the `dsh` process's
  `stdout` / `stderr`.
