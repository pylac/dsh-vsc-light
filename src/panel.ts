import * as vscode from 'vscode';
import * as dshProc from './service/process';
import * as auth from './service/auth';
import * as proxy from './service/proxy';
import { getWebviewContent } from './webview-html';
import { isCancelled } from './util/cancel';
import { summariseError } from './util/error-summary';
import { isMissingPathError } from './util/errors';
import { t } from './util/l10n';
import { classifyExternalLink } from './util/external-link';
import { formatReference, lastSelectedLine } from './util/reference';
import { redactToken } from './util/redact';
import { DEFAULT_PROFILE_ARGS, findProxyBreakingArgs } from './util/cli';
import { setStatusRunning } from './status-bar';
import { log, logError, logWarn, showLog } from './util/log';
import { copyDiagnostics, recordLastError } from './service/diagnostics';

/**
 * Panel and startup flow orchestration.
 *
 * Concurrency protection: inflightShow guarantees that only one startup flow runs at a time. If the
 * user clicks the icon again during startup, the second call reuses the first Promise and does not
 * spawn DSH twice.
 *
 * Likewise, stopAll waits for inflightShow to finish before cleaning up resources. That avoids the
 * case where the process has not finished spawning when stopAll is called, cleanup misses it, and
 * the process then runs on in the background.
 */

let dshPanel: vscode.WebviewPanel | undefined;
let inflightShow: Promise<void> | undefined;

/**
 * Maximum text length the clipboard bridge may carry (2 MiB).
 *
 * The injected script uses the same cap; both sides clamp because the payload originates in the
 * page — without a cap, a runaway page could push an entire session log through postMessage.
 */
const MAX_COPY_TEXT_LENGTH = 2 * 1024 * 1024;

/** Whether the "these arguments break the proxy" warning was already shown, so it pops only once. */
let warnedUnsupportedArgs = false;

/**
 * Warn about `dsh.args` entries that break the proxy.
 *
 * Why warn instead of blocking: the user may have their own setup and the extension does not get to
 * decide — but a bare "authentication failed" hides the cause, and one sentence saves a debugging
 * round.
 */
function warnUnsupportedArgsOnce(): void {
    if (warnedUnsupportedArgs) { return; }

    const configured = vscode.workspace.getConfiguration('dsh').get<string[]>('args', [...DEFAULT_PROFILE_ARGS]);
    const offending = findProxyBreakingArgs(configured);
    if (offending.length === 0) { return; }

    warnedUnsupportedArgs = true;
    const flags = offending.join(', ');
    logWarn(`[PANEL] dsh.args contains ${flags}: the panel only talks to a loopback http listener, so a public URL or TLS makes authentication fail`);
    void vscode.window.showWarningMessage(t(
        'The dsh.args setting contains {0}. The panel talks to the local http listener, so a public URL or a TLS listener cannot work. Remove it, or run "dsh web" outside VS Code.',
        flags
    ));
}

export async function togglePanel(context: vscode.ExtensionContext): Promise<void> {
    if (dshPanel) {
        dshPanel.dispose();
        dshPanel = undefined;
        return;
    }
    await showPanel(context);
}

export async function showPanel(context: vscode.ExtensionContext): Promise<void> {
    if (inflightShow) {
        // A startup flow is already running → reuse it to avoid double startup
        return inflightShow;
    }

    // A panel already exists → bring it back and never create a second one.
    // Without this guard, any code path that calls showPanel opportunistically would give the same
    // DSH two pages; passing its own column plus preserveFocus keeps the panel in place and the
    // editor focused.
    if (dshPanel) {
        dshPanel.reveal(dshPanel.viewColumn ?? vscode.ViewColumn.Beside, true);
        return;
    }

    inflightShow = doShowPanel(context);
    try {
        await inflightShow;
    } finally {
        inflightShow = undefined;
    }
}

async function doShowPanel(context: vscode.ExtensionContext): Promise<void> {
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Preparing DSH...'),
            // Cancellable: this chain can take up to 120s (token) + 30s (port) + auth retries,
            // and a mis-click should not force the user to wait it out.
            cancellable: true
        },
        async (progress, token) => {
            const isCancelled = () => token.isCancellationRequested;
            if (!(await startService(progress, isCancelled))) { return; }

            // Create the panel.
            // Created after the service is ready: creating it starts loading the iframe, and a
            // panel created before the service exists would only show the error layer while
            // waiting. If the user has already disposed (stopAll was called) during inflightShow,
            // the subsequent logic will fail because dshProc has stopped — the caller's state
            // check handles this.
            progress.report({ message: t('Opening the panel...') });
            const panel = vscode.window.createWebviewPanel(
                'dshWebUI',
                'DSH',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    // Keep the webview alive when the panel goes to the background: otherwise the
                    // iframe is destroyed and rebuilt, silently losing a streaming conversation.
                    retainContextWhenHidden: true
                }
            );
            attachPanel(context, panel);
        }
    );
}

/**
 * Start DSH and the proxy; reuse whichever is already running.
 *
 * Failures are reported here and return false — callers do not have to classify errors, and they
 * must not clean up either: failWith already called stopAll.
 *
 * Why this is extracted: creating a panel and reviving one after a window reload share the same
 * startup, and a copy would drift.
 */
async function startService(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    isCancelled: () => boolean
): Promise<boolean> {
    // 1. DSH is not running → start + authenticate
    if (!dshProc.isRunning()) {
        // Warn about proxy-breaking arguments before starting, so a later authentication failure
        // has a cause in the log.
        warnUnsupportedArgsOnce();

        progress.report({ message: t('Starting the DSH service process...') });
        let result: { port: number; token: string };
        try {
            result = await dshProc.startDSH(isCancelled);
        } catch (err) {
            await failWith(t('DSH failed to start'), err);
            return false;
        }

        progress.report({ message: t('Obtaining the authentication cookie...') });
        const authUrl = `http://127.0.0.1:${result.port}/?token=${result.token}`;
        // Remember this URL: DSH prints it exactly once, and the proxy needs it to re-authenticate
        // once when the cookie expires (see the proxy's 401 branch).
        auth.rememberAuthUrl(authUrl);
        try {
            await auth.exchangeCookie(authUrl, 30, isCancelled);
        } catch (err) {
            await failWith(t('DSH authentication failed'), err);
            return false;
        }

        // Register the unexpected-exit callback: when DSH crashes, show a retryable error state in
        // place. The panel is not disposed: the user is looking at a conversation, and yanking it
        // away is worse than leaving it there — which also makes a one-click restart possible.
        dshProc.setOnExit(() => {
            log('[PANEL] DSH process exited unexpectedly; cleaning up');
            proxy.stopProxy();
            auth.resetCookie();
            setStatusRunning(false);
            showPanelError(t('The DSH service has exited. Click Retry to start it again.'));
            vscode.window.showWarningMessage(t('The DSH service has exited.'));
        });
    }

    // 2. Proxy is not running → start it
    if (!proxy.isRunning()) {
        progress.report({ message: t('Starting the proxy server...') });
        try {
            await proxy.startProxy(dshProc.getPort());
        } catch (err) {
            await failWith(t('The proxy failed to start'), err);
            return false;
        }
    }

    setStatusRunning(true, proxy.getProxyOrigin());
    return true;
}

/**
 * Attach a webview panel to the running service (shared by creation and revival).
 *
 * This only wires things up: the icon, the entry URL, message handling, and dispose handling.
 */
function attachPanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
    dshPanel = panel;
    // Set the icon (a single file or a light/dark pair).
    panel.iconPath = {
        light: vscode.Uri.joinPath(context.extensionUri, 'res', 'dsh-vsc-light-icon-light.svg'),
        dark: vscode.Uri.joinPath(context.extensionUri, 'res', 'dsh-vsc-light-icon-dark.svg')
    };

    const proxyOrigin = proxy.getProxyOrigin();
    // The entry URL (carrying the one-time session secret) rather than the bare origin: the first
    // visit trades it for the session cookie, without which the proxy's own guard would reject
    // later requests.
    panel.webview.html = getWebviewContent(proxy.getEntryUrl());

    // Link requests, clipboard relays, and the error layer's buttons all end up here.
    panel.webview.onDidReceiveMessage((msg) => {
        void handleWebviewMessage(msg, proxyOrigin);
    });

    panel.onDidDispose(() => {
        // Only clear the reference; the DSH process and proxy are kept (reused on next open).
        // Identity check: should a second panel ever exist, the old panel's dispose must not blank
        // the new reference.
        if (dshPanel === panel) { dshPanel = undefined; }
    });
}

/**
 * Revive the DSH panel after a window reload.
 *
 * Why this exists: adding or removing workspace folders or installing an extension makes VS Code
 * reload the window; when the extension host restarts deactivate() kills DSH while the in-process
 * proxy dies with it, leaving the panel on a "reconnecting" page.
 *
 * VS Code revives a panel whose view type has a registered serializer; this restarts the service
 * and hands the panel the new entry URL, so the user does not have to press the shortcut again.
 *
 * A failed revival disposes the panel: a blank panel is more confusing than none.
 */
export async function restorePanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): Promise<void> {
    // The revived webview carries old state; reset the options before writing html so the iframe
    // reloads.
    panel.webview.options = { enableScripts: true };

    // A panel already exists (the user opened one before the revival finished): close the revived
    // one, or the same DSH would show up in two panels.
    if (dshPanel) {
        panel.dispose();
        return;
    }

    // Reuse the startup mutex: only one flow may run when a revival and a manual open race.
    if (inflightShow) {
        try { await inflightShow; } catch { /* failure already handled inside */ }
        if (dshPanel) {
            panel.dispose();
            return;
        }
    }

    inflightShow = doRestorePanel(context, panel);
    try {
        await inflightShow;
    } finally {
        inflightShow = undefined;
    }
}

async function doRestorePanel(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): Promise<void> {
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t('Preparing DSH...'),
            cancellable: true
        },
        async (progress, token) => {
            const isCancelled = () => token.isCancellationRequested;
            if (!(await startService(progress, isCancelled))) {
                panel.dispose();
                return;
            }
            attachPanel(context, panel);
        }
    );
}

/**
 * Show the error layer inside the panel.
 *
 * Disposing the panel is a last resort: the user's conversation lives there, and keeping it with a
 * one-click retry is better.
 */
function showPanelError(message: string): void {
    void dshPanel?.webview.postMessage({ type: 'showError', message });
}

export async function stopAll(): Promise<void> {
    // Wait for any in-progress startup flow to finish before cleaning up
    if (inflightShow) {
        try {
            await inflightShow;
        } catch { /* startup failure already handled inside; ignored here */ }
    }

    if (dshPanel) {
        dshPanel.dispose();
        dshPanel = undefined;
    }
    proxy.stopProxy();
    auth.resetCookie();
    setStatusRunning(false);
    // Wait for the process to actually exit: restartService immediately starts it again, and
    // without waiting, two DSH processes would briefly coexist.
    await dshProc.stopDSH();
}

export async function referenceCurrentPosition(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage(t('Open a code file first.'));
        return;
    }

    // An unsaved document has no path on disk, so the agent could not read it; saying so beats copying junk.
    if (editor.document.uri.scheme !== 'file') {
        vscode.window.showWarningMessage(t('Save the file first; only files on disk can be referenced.'));
        return;
    }

    // Always the absolute path.
    //
    // A relative path reads shorter, but it depends on a notion the two sides do not share: "the
    // workspace root". A VS Code multi-root workspace has several roots while a DSH session has
    // exactly one working directory; asRelativePath(uri, true) also prefixes the folder name
    // (`tools/README.md`), and DSH then looks for `<session workspace>/tools/README.md` — a path
    // that does not exist. Dropping the prefix does not help either: same-named files in two roots
    // would impersonate each other. An absolute path has none of that ambiguity and merely reads
    // longer. The read/write boundary is unaffected: reads are not sandboxed, and writes are still
    // judged against the session workspace.
    const absolutePath = editor.document.uri.fsPath;

    // A selection references the whole selection; a bare cursor references the current line.
    // Multiple cursors use the primary selection only (editor.selection): several @references
    // copied at once would neither read well nor paste as one prompt.
    const selection = editor.selection;
    const startLine = selection.start.line;
    const endLine = lastSelectedLine(startLine, selection.end.line, selection.end.character);
    const reference = formatReference(absolutePath, startLine, endLine);

    await vscode.env.clipboard.writeText(reference);

    // The panel is no longer brought forward automatically after copying.
    //
    // Why: Beside in reveal(ViewColumn.Beside) is resolved relative to the active column, so a
    // panel that is not in the active column gets moved to another one. When a webview crosses
    // columns, VS Code recreates it and the iframe reloads, resetting the panel proportions the
    // user tuned. Copying a reference must not do that. The notification now carries a button,
    // leaving the decision to the user.
    const wasVisible = dshPanel?.visible === true;
    const openPanelLabel = t('Open Panel');
    const copiedMessage = t('Copied: {0} (paste it into DSH with Ctrl+V)', reference);
    const picked = wasVisible
        ? await vscode.window.showInformationMessage(copiedMessage)
        : await vscode.window.showInformationMessage(copiedMessage, openPanelLabel);

    if (picked === openPanelLabel) {
        await openDshPanel(context);
    }
}

/**
 * Open or re-summon the panel without ever changing the column it already occupies.
 *
 * Division of labour with showPanel:
 *   panel exists → reveal only (its own column plus preserveFocus): no new panel, no move;
 *   no panel → showPanel runs the full startup flow.
 *
 * showPanel cannot be called directly: it calls createWebviewPanel even when a panel exists,
 * which would give the same DSH page two panels.
 */
async function openDshPanel(context: vscode.ExtensionContext): Promise<void> {
    if (dshPanel) {
        dshPanel.reveal(dshPanel.viewColumn ?? vscode.ViewColumn.Beside, true);
        return;
    }
    await showPanel(context);
}

/**
 * Handle messages coming from the webview.
 *
 * Four kinds of message:
 *   - openExternal: the DSH page inside the iframe asks for a link to be opened by the OS
 *   - copyText: the page's clipboard bridge asks to write the system clipboard (the cross-origin
 *     iframe lacks that permission)
 *   - retry: the error layer's retry button (delegated to the restart command, since the port
 *     changes on restart)
 *   - showLogs: the "view logs" button
 *
 * For openExternal this is the last and only authoritative gate. The script injected into the page
 * only does coarse filtering; classifyExternalLink() decides what may actually be opened. Even if
 * the page's script were bypassed and arbitrary postMessages forged, nothing outside the allowlist
 * can be opened.
 */
async function handleWebviewMessage(msg: unknown, appOrigin: string): Promise<void> {
    if (!msg || typeof msg !== 'object') { return; }

    const { type } = msg as { type?: unknown };

    if (type === 'copyText') {
        // Text forwarded by the clipboard bridge inside the page (a cross-origin iframe cannot
        // write the system clipboard; see util/html-bridge.ts). The cap matches the injected
        // script.
        const { text } = msg as { text?: unknown };
        if (typeof text === 'string' && text.length > 0 && text.length <= MAX_COPY_TEXT_LENGTH) {
            try {
                await vscode.env.clipboard.writeText(text);
            } catch (err) {
                logError('[PANEL] Clipboard write failed:', err);
            }
        }
        return;
    }

    if (type === 'retry') {
        await vscode.commands.executeCommand('dsh.restartService');
        return;
    }

    if (type === 'showLogs') {
        showLog();
        return;
    }

    const { url } = msg as { url?: unknown };
    if (type !== 'openExternal' || typeof url !== 'string') { return; }

    const decision = classifyExternalLink(url, appOrigin);
    if (decision !== 'open') {
        // "ignore" is normal (in-app links should never reach here); "block" is what deserves a trace
        if (decision === 'block') {
            log(`[PANEL] Refused to open link: ${url}`);
        }
        return;
    }

    try {
        await vscode.env.openExternal(vscode.Uri.parse(url, true));
    } catch (err) {
        logError('[PANEL] openExternal failed:', err);
    }
}

/**
 * Unified error handling: clean up, show one readable line, and offer a way forward.
 *
 * Why err.message is no longer dumped into the dialog: the message of a failed startup carries the
 * entire captured stdout / stderr (meant for the log), and popping that yields a screen-filling
 * multi-line dialog where the user can find neither the point nor a way to copy it. So the dialog
 * gets only the first line, the full text goes to the log, and the buttons lead there.
 *
 * Cancellation is not an error: the user asked to stop, and a red dialog scolding them for it is
 * wrong.
 */
async function failWith(msg: string, err: unknown): Promise<void> {
    await stopAll();

    if (isCancelled(err)) {
        log(`[PANEL] Startup cancelled (${msg})`);
        return;
    }

    // An error may carry DSH stdout (the startup-failure dump), so the token is masked before the
    // text reaches the log (pasted into issues) and "Copy Error Details" (onto the clipboard).
    const detail = redactToken(err instanceof Error ? err.message : String(err));
    logError(`${msg}:`, err instanceof Error ? redactToken(err.stack ?? err.message) : detail);

    // Keep one line for the diagnostics report: it wants the symptom, and the full stack is already in the log.
    recordLastError(`${msg}: ${detail}`);

    // On a path-probe failure what the user actually needs is "take me to that setting", not a
    // sentence telling them to go find the settings page themselves.
    //
    // The button labels must be captured before comparing: t() returns the translated string
    // when a language pack is present, so comparing against a source literal would silently break
    // under the other language (the button would do nothing).
    const openSettingsLabel = t('Open Settings');
    const showLogsLabel = t('Show Logs');
    const copyDetailsLabel = t('Copy Error Details');
    const diagnosticsLabel = t('Copy Diagnostics');

    const missing = isMissingPathError(err) ? err : undefined;
    const buttons = missing
        ? [openSettingsLabel, showLogsLabel, diagnosticsLabel]
        : [showLogsLabel, copyDetailsLabel, diagnosticsLabel];

    const picked = await vscode.window.showErrorMessage(
        t('{0}: {1}', msg, summariseError(detail)),
        ...buttons
    );

    if (picked === openSettingsLabel && missing) {
        await vscode.commands.executeCommand('workbench.action.openSettings', missing.settingId);
    } else if (picked === showLogsLabel) {
        showLog();
    } else if (picked === copyDetailsLabel) {
        await vscode.env.clipboard.writeText(`${msg}\n\n${detail}`);
    } else if (picked === diagnosticsLabel) {
        await copyDiagnostics();
    }
}