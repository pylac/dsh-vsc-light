/**
 * DSH command-line argument assembly and startup output parsing.
 *
 * Only pure functions live here — no vscode import and no global state is read or written, so
 * they can be loaded and checked outside an extension host.
 */

/** The default arguments used when `dsh.args` is not configured. */
export const DEFAULT_PROFILE_ARGS: readonly string[] = ['--profile', 'web', '--no-open'];

/** The port flag. */
const PORT_FLAG = '--port';

/**
 * Inject the port assigned by the extension into the argument list, removing any --port already
 * present in the user config.
 *
 * Both spellings are removed:
 *   --port 8080   — the following argument is consumed only when it really is a number
 *   --port=8080
 *
 * Why removal is mandatory: the extension's --port must win, otherwise the proxy would point at a
 * port DSH never listens on.
 *
 * The input array is never mutated — baseArgs comes from the user configuration and mutating it
 * would pollute that object.
 */
export function withPort(baseArgs: readonly string[], port: number): string[] {
    const out: string[] = [];

    for (let i = 0; i < baseArgs.length; i++) {
        const arg = baseArgs[i];

        if (arg === PORT_FLAG) {
            // Only treat the next token as its value when it really is a number, to avoid
            // swallowing a following flag (such as `--port --no-open`)
            const next = baseArgs[i + 1];
            if (next !== undefined && /^\d+$/.test(next)) { i++; }
            continue;
        }

        if (arg.startsWith(`${PORT_FLAG}=`)) { continue; }

        out.push(arg);
    }

    out.push(PORT_FLAG, String(port));
    return out;
}

/**
 * Parse the authentication token from DSH's startup output.
 *
 * Why the character set is relaxed: the token may be base64 (containing + / =) or
 * percent-encoded, and allowing only [A-Za-z0-9_-] would truncate them, making authentication use
 * a damaged token.
 *
 * Why control characters are excluded: logs may contain ANSI color escapes (\x1b[...m). DSH
 * prints a full URL, so the token is followed by a newline, whitespace, or a quote — that is where
 * matching must stop.
 *
 * Returns null when the token has not appeared yet; the caller should keep accumulating output.
 */
export function parseToken(output: string): string | null {
    const m = output.match(/token=([^\s&"'<>\x00-\x1f]+)/);
    if (!m) { return null; }

    const raw = m[1];
    try {
        return decodeURIComponent(raw);
    } catch {
        // Malformed percent sequence — return as-is rather than dropping the whole token over a
        // decode failure
        return raw;
    }
}

/**
 * dsh flags that break the extension's proxy.
 *
 * Why they are fatal: the extension exchanges credentials at `http://127.0.0.1:<port>` and
 * assumes the panel can reach that loopback address. `--public-url` changes the address DSH
 * prints, and the TLS flags switch the listener to https — both break that assumption, and the
 * failure surfaces only as a confusing authentication error.
 *
 * This only warns and never blocks: the user may have their own setup, and the extension does not
 * get to decide.
 */
export const PROXY_BREAKING_FLAGS: readonly string[] = ['--public-url', '--tls-cert', '--tls-key'];

/**
 * Find the flags that break the proxy (both spellings are recognized).
 *
 * @param args The configured launch arguments.
 * @returns The matched flag names, deduplicated in `PROXY_BREAKING_FLAGS` order; empty when
 * nothing matched.
 */
export function findProxyBreakingArgs(args: readonly string[]): string[] {
    const found: string[] = [];
    for (const flag of PROXY_BREAKING_FLAGS) {
        const hit = args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
        if (hit) { found.push(flag); }
    }
    return found;
}
