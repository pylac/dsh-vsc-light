import * as vscode from 'vscode';
import { t } from './util/l10n';

/**
 * The status bar indicator.
 *
 * Why this is needed:
 *   DSH is a long-lived background service: closing the panel leaves it running, holding a port and
 *   memory. Without an indicator, "is it running right now" can only be answered by opening the
 *   panel, or by digging through Task Manager.
 *
 * Shown only while running: it takes no space otherwise and adds no noise for people not using the
 * feature. The panel is opened from the editor title icon, so the status bar does not need to
 * duplicate that entry point.
 */

let item: vscode.StatusBarItem | undefined;

/** Create the status bar item (once). */
export function initStatusBar(): vscode.StatusBarItem {
    if (!item) {
        item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        item.name = 'DSH';
        // Clicking toggles the panel: the same command as the title bar icon
        item.command = 'dsh.togglePanel';
    }
    return item;
}

/**
 * Update the status.
 *
 * @param running Whether DSH is running.
 * @param origin The proxy origin, shown in the tooltip while running to help with debugging.
 */
export function setStatusRunning(running: boolean, origin = ''): void {
    if (!item) { return; }

    if (!running) {
        item.hide();
        return;
    }

    item.text = '$(dsh-vsc-light-status-icon) DSH';
    item.tooltip = origin === ''
        ? t('DSH is running — click to show or hide the panel')
        : t('DSH is running ({0}) — click to show or hide the panel', origin);
    item.show();
}

/** Dispose the status bar item. */
export function disposeStatusBar(): void {
    item?.dispose();
    item = undefined;
}
