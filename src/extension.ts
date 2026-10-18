import * as vscode from 'vscode';
import * as dshProc from './service/process';
import { copyDiagnostics, initDiagnostics } from './service/diagnostics';
import { initLog, log, showLog } from './util/log';
import { t } from './util/l10n';
import { invalidatePathCache } from './util/paths';
import { disposeStatusBar, initStatusBar } from './status-bar';
import {
    togglePanel,
    showPanel,
    stopAll,
    restorePanel,
    referenceCurrentPosition
} from './panel';

export function activate(context: vscode.ExtensionContext) {
    initLog();
    log('DSH extension activated');

    // The diagnostics report needs context such as the extension version; the command may run at
    // any time after this.
    initDiagnostics(context);

    // The status bar item is shown/hidden by the panel side according to the running state; this
    // creates it and registers it for disposal.
    context.subscriptions.push(initStatusBar());

    // A window reload (adding/removing workspace folders, installing extensions, …) restarts the
    // extension host, and deactivate() kills DSH while the in-process proxy dies with the host.
    // Re-attaching the revived panel to a freshly started service saves the user from pressing the
    // shortcut again.
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('dshWebUI', {
            deserializeWebviewPanel: (panel: vscode.WebviewPanel) => restorePanel(context, panel)
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.togglePanel', () => togglePanel(context))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.stopService', async () => {
            await stopAll();
            vscode.window.showInformationMessage(t('DSH service stopped.'));
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.restartService', async () => {
            await stopAll();
            await showPanel(context);
            vscode.window.showInformationMessage(t('DSH service restarted.'));
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.referenceCode', () => referenceCurrentPosition(context))
    );
    // A log channel with no entry point makes users hunt for the channel name when reporting a bug
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.showLogs', () => showLog())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('dsh.copyDiagnostics', () => copyDiagnostics())
    );

    // The probe results are cached, so they must be dropped as soon as the configuration changes;
    // otherwise "fail, fill in the path in settings, retry" only takes effect after reloading the
    // window.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('dsh.binPath') || e.affectsConfiguration('dsh.nodePath')) {
                invalidatePathCache();
                log('[DSH] Path configuration changed; probe cache cleared');
            }
        })
    );
}

/**
 * Fallback cleanup when the extension is deactivated.
 *
 * Why only kill DSH and not the proxy:
 *   The proxy is an http.Server running inside the Extension Host process. When the Extension Host
 *   is destroyed, the OS automatically closes all its sockets — the proxy disappears with it.
 *   DSH is a separate process and must be explicitly killed.
 *
 * Use killDshSync instead of stopDSH:
 *   The Extension Host is about to exit and there is no time to wait for an asynchronous kill.
 *   killDshSync uses execSync to block until taskkill completes, ensuring DSH does not become an
 *   orphan process.
 */
export function deactivate() {
    log('DSH extension is deactivating; stopping the DSH process...');
    dshProc.killDshSync();
    disposeStatusBar();
}
