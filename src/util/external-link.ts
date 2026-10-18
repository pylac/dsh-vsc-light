/**
 * Rules for deciding whether a link should be handed to the OS browser.
 *
 * Why this module exists:
 *   The DSH frontend renders every http/https link with target="_blank" (see the renderer in
 *   dsh-web-frontend), while VS Code's webview iframe sandbox carries no allow-popups — the
 *   browser rejects the new-window request outright, so a click appears to do nothing. The only
 *   way out is to send the URL back to the extension and let vscode.env.openExternal open it.
 *
 * This is the single source of truth for "what may be opened":
 *   the script the proxy injects into the page takes its scheme allowlist from here, and the
 *   extension's final check calls the same function, so the two cannot drift apart.
 */

/**
 * URL schemes allowed to be handed to the OS.
 *
 * Deliberately minimal: every extra scheme is another channel from model-generated chat content
 * into the local machine.
 */
export const OPENABLE_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

/** What to do with a link. */
export type ExternalLinkDecision =
    /** In-app navigation — leave it to the page. */
    | 'ignore'
    /** Cross-origin link, safe to open externally. */
    | 'open'
    /** Must be dropped. */
    | 'block';

/** Whether a scheme is allowlisted (case-insensitive). */
export function isOpenableScheme(scheme: string): boolean {
    return (OPENABLE_SCHEMES as readonly string[]).includes(scheme.toLowerCase());
}

/**
 * Decide what to do with a link.
 *
 *   - Same origin as appOrigin    → ignore (DSH's own routing must not be hijacked)
 *   - Cross-origin, allowlisted   → open
 *   - Everything else             → block
 *
 * file: must be blocked — openExternal would open a local file with the OS default application,
 * and chat content is model-generated, so allowing it would open a channel to local files.
 * javascript: / data: / blob: and every custom scheme are blocked for the same reason.
 *
 * href is resolved against appOrigin (matching browser behaviour), so relative paths classify as
 * in-app.
 */
export function classifyExternalLink(href: string, appOrigin: string): ExternalLinkDecision {
    if (!href) { return 'block'; }

    let url: URL;
    try {
        url = new URL(href, appOrigin);
    } catch {
        // Nothing parseable means nothing to open
        return 'block';
    }

    if (!isOpenableScheme(url.protocol)) { return 'block'; }

    // Non-special schemes such as mailto: have the string "null" as their origin, never equal to
    // appOrigin
    if (url.origin === appOrigin) { return 'ignore'; }

    return 'open';
}
