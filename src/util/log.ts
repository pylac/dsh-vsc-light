/**
 * The log channel.
 *
 * Why LogOutputChannel instead of console.log:
 *   console.log output is only visible in the Extension Host's DevTools, which ordinary users have
 *   no way to view. LogOutputChannel writes logs to VS Code's "Output" panel (Ctrl+Shift+U), so
 *   users can screenshot or copy them when reporting bugs.
 *
 * It also supports log levels: trace / debug / info / warn / error. Users can adjust the display
 * level in settings to filter out noise.
 *
 * Why the vscode API is resolved lazily instead of imported at the top:
 *   Outside the extension host the module does not exist at all, and a top-level import would make
 *   every util / service module that references log fail to load — including the proxy, auth, and
 *   port-waiting code that does not need vscode. Falling back to console when the API is
 *   unavailable is the same fallback path as "initLog not called yet".
 */
import { getVscodeApi } from './vscode-api';

let channel: import('vscode').LogOutputChannel | undefined;

/** Initialize the log channel. Call once in activate(). */
export function initLog(): void {
    if (channel) { return; }

    const api = getVscodeApi();
    if (!api) { return; }

    channel = api.window.createOutputChannel('DSH', { log: true });
}

/**
 * Convert arbitrary arguments into a readable string.
 *
 * Handles three cases:
 *   - String: as-is
 *   - Error: print the stack (far more informative than the message)
 *   - Others: try JSON.stringify, falling back to String()
 */
function fmt(args: unknown[]): string {
    return args.map(a => {
        if (typeof a === 'string') { return a; }
        if (a instanceof Error) { return a.stack ?? a.message; }
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    }).join(' ');
}

/**
 * Open the output panel and reveal the DSH channel.
 *
 * Used by the "view logs" button on error notifications: when something breaks and the user needs
 * the log, they should not have to hunt for the channel name in the output panel's dropdown.
 */
export function showLog(): void {
    if (!channel) { initLog(); }
    // preserveFocus: do not steal editor focus, the user is only taking a look at the log
    channel?.show(true);
}

export function log(...args: unknown[]): void {
    if (channel) {
        channel.info(fmt(args));
    } else {
        // Fallback when initLog has not been called or we are not in an extension host, so logs
        // are never lost
        console.log(...args);
    }
}

export function logWarn(...args: unknown[]): void {
    if (channel) {
        channel.warn(fmt(args));
    } else {
        console.warn(...args);
    }
}

export function logError(...args: unknown[]): void {
    if (channel) {
        channel.error(fmt(args));
    } else {
        console.error(...args);
    }
}
