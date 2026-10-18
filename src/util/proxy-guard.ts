/**
 * The three checks at the proxy entrance: Host, source, session secret.
 *
 * What this defends against:
 *   The proxy listens on 127.0.0.1 and injects DSH's authentication cookie into requests,
 *   and rewrites Origin/Referer to values DSH trusts. Whoever can reach this port therefore
 *   gets a fully authenticated DSH client — and DSH is an agent that can run tools and commands.
 *
 *   Two kinds of source must be blocked separately, because their ability to forge headers differs completely:
 *     1. Web pages — the browser sets Origin/Referer for them and they cannot forge those,
 *        so a source check is enough (B1).
 *     2. Local processes — they write whatever headers they like, so the source check is worthless,
 *        and only a secret they cannot guess works (B2).
 *
 *   A third kind: DNS rebinding — an attacker's domain resolves to 127.0.0.1,
 *   at which point the browser considers the target same-origin and the Origin check fails; only the Host check stops it (B3).
 */

/** Session cookie name. */
export const SESSION_COOKIE = 'dsh_proxy_session';

/** Bootstrap path prefix: the iframe's first load carries the secret in it. */
export const SESSION_PATH_PREFIX = '/__dsh_session=';

export interface GuardInput {
    readonly headers: Record<string, unknown>;
    readonly requestUrl: string;
    /** Expected Host, e.g. 127.0.0.1:12345. */
    readonly expectedHost: string;
    /** The proxy's own origin, e.g. http://127.0.0.1:12345. */
    readonly expectedOrigin: string;
    readonly sessionSecret: string;
}

export type GuardOutcome =
    /** Allowed. bootstrap means this is the secret-bearing bootstrap request: issue the cookie and redirect. */
    | { readonly ok: true; readonly bootstrap: boolean }
    | { readonly ok: false; readonly status: number; readonly reason: string };

/**
 * Whether the Host is us.
 *
 * The key step of DNS rebinding: the attacker points their domain at 127.0.0.1,
 * so the browser treats it as same-origin and the Origin header looks perfectly normal — but the Host header is still the attacker's domain.
 */
export function isAllowedHost(host: string | undefined, expectedHost: string): boolean {
    return String(host ?? '').toLowerCase() === expectedHost.toLowerCase();
}

/**
 * Whether the source is trusted.
 *
 * Rules:
 *   - Origin present: it must equal our own origin. Cross-origin fetch/XHR/WebSocket always send one,
 *     so this blocks remote web pages.
 *   - No Origin but a Referer: when that Referer is http(s) it must be same-origin;
 *     anything non-http(s) is allowed — the outer document is vscode-webview://<uuid>,
 *     which iframe navigations carry, and blocking it would shut our own panel out.
 *   - Neither: allowed (that is what top-level navigation looks like); the session secret covers this case.
 *
 * To be explicit: a local process can forge both headers freely, so this check only means anything against a browser.
 */
export function isAllowedOrigin(
    origin: string | undefined,
    referer: string | undefined,
    expectedOrigin: string
): boolean {
    const originValue = String(origin ?? '');
    if (originValue !== '') {
        return originValue === expectedOrigin;
    }

    const refererValue = String(referer ?? '');
    if (refererValue === '') { return true; }

    let url: URL;
    try {
        url = new URL(refererValue);
    } catch {
        // Unparseable: treat it as a non-http(s) source and let the session secret cover it
        return true;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') { return true; }

    return url.origin === expectedOrigin;
}

/**
 * Read the bootstrap secret out of the request path.
 *
 * Only the first path segment is considered, and only in the `/__dsh_session=<value>` form; otherwise null.
 */
export function readBootstrapSecret(requestUrl: string): string | null {
    const path = String(requestUrl ?? '').split('?')[0].split('#')[0];
    if (!path.startsWith(SESSION_PATH_PREFIX)) { return null; }

    const value = path.slice(SESSION_PATH_PREFIX.length);
    if (value === '' || value.includes('/')) { return null; }

    return value;
}

/** Parse a Cookie header. */
export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    const raw = String(header ?? '');
    if (raw === '') { return out; }

    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) { continue; }
        const name = part.slice(0, eq).trim();
        if (name === '') { continue; }
        out[name] = part.slice(eq + 1).trim();
    }

    return out;
}

/** Whether the request carries the correct session cookie. */
export function hasSessionCookie(cookieHeader: string | undefined, sessionSecret: string): boolean {
    return parseCookies(cookieHeader)[SESSION_COOKIE] === sessionSecret;
}

/**
 * Scrub the bootstrap secret out of a Referer.
 *
 * After a 302 the browser may send the original secret-bearing URL back as the Referer
 * (same-origin redirects send the full path by default), and forwarding that to DSH is a pointless leak.
 * The bootstrap response also sets Referrer-Policy: no-referrer; this is the second line of defence.
 */
export function scrubSecretFromReferer(referer: string, sessionSecret: string): string {
    if (referer === '' || sessionSecret === '') { return referer; }
    return referer.split(sessionSecret).join('');
}

/**
 * The entrance to all three checks.
 *
 * The order is deliberate: Host first (cheapest, and stops DNS rebinding),
 * then source, and only then the session check that has to compare a secret.
 */
export function guardRequest(input: GuardInput): GuardOutcome {
    if (!isAllowedHost(String(input.headers.host ?? ''), input.expectedHost)) {
        return { ok: false, status: 403, reason: 'host' };
    }

    if (!isAllowedOrigin(
        input.headers.origin as string | undefined,
        input.headers.referer as string | undefined,
        input.expectedOrigin
    )) {
        return { ok: false, status: 403, reason: 'origin' };
    }

    const bootstrapSecret = readBootstrapSecret(input.requestUrl);
    if (bootstrapSecret !== null) {
        return bootstrapSecret === input.sessionSecret
            ? { ok: true, bootstrap: true }
            : { ok: false, status: 403, reason: 'bootstrap-secret' };
    }

    if (hasSessionCookie(input.headers.cookie as string | undefined, input.sessionSecret)) {
        return { ok: true, bootstrap: false };
    }

    return { ok: false, status: 403, reason: 'session' };
}
