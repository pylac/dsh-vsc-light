import * as http from 'http';
import { CancelCheck, throwIfCancelled } from '../util/cancel';
import { t } from '../util/l10n';
import { log } from '../util/log';

/**
 * Authentication cookie exchange module.
 *
 * Responsibility: use a token-bearing URL to exchange for an authentication
 * cookie from DSH; afterwards all proxied requests carry this cookie to pass
 * DSH authentication.
 *
 * Why retries are needed:
 *   When DSH prints "dsh web: http://...", the HTTP server may not be fully
 *   ready yet. An ECONNREFUSED on the first request is normal; waiting a few
 *   hundred milliseconds is enough.
 *   This is not "network instability", it is "startup timing".
 *
 * Only retry on recoverable errors (ECONNRESET / ECONNREFUSED / EPIPE / ETIMEDOUT).
 * Other errors (malformed URL, DNS failure, etc.) are thrown immediately to
 * avoid wasting time.
 */

let dshAuthCookie = '';

/**
 * The token URL used to exchange for the cookie.
 *
 * It is kept so an expired cookie can be re-obtained automatically: the URL DSH prints appears only once at startup,
 * and without remembering it there is no way to exchange for a new one.
 */
let rememberedAuthUrl: string | undefined;

/** The in-flight re-authentication, used to coalesce concurrent requests. */
let inflightReauth: Promise<boolean> | undefined;

export function getCookie(): string { return dshAuthCookie; }

/**
 * Clear the cookie and the remembered token URL.
 *
 * The semantics are "this session is over", so both go together —
 * keeping the URL would make the next 401 exchange a token that is already dead.
 */
export function resetCookie(): void {
    dshAuthCookie = '';
    rememberedAuthUrl = undefined;
    inflightReauth = undefined;
}

/** Remember the token URL so a 401 can trigger automatic re-authentication. */
export function rememberAuthUrl(url: string): void {
    rememberedAuthUrl = url;
}

/**
 * Re-exchange for the authentication cookie.
 *
 * Returns whether it succeeded and never throws — the caller is the proxy's 401 branch,
 * which prefers "on failure just pass the 401 through" over an exception tearing down request handling.
 *
 * Coalescing: when a cookie expires, several requests on the page hit 401 at the same moment,
 * and exchanging once per request would fire a burst of pointless authentication calls.
 */
export function reauthenticate(): Promise<boolean> {
    if (inflightReauth) { return inflightReauth; }
    if (!rememberedAuthUrl) { return Promise.resolve(false); }

    const url = rememberedAuthUrl;
    inflightReauth = exchangeCookie(url)
        .then(() => {
            // Logs are English: they are diagnostics that end up in bug reports.
            log('[DSH] Authentication cookie refreshed');
            return true;
        })
        .catch((err: unknown) => {
            log('[DSH] Re-authentication failed:', (err as Error).message);
            return false;
        })
        .finally(() => {
            inflightReauth = undefined;
        });

    return inflightReauth;
}

/** Custom error: no Set-Cookie header in the HTTP response. */
class NoCookieError extends Error {
    readonly code = 'NO_COOKIE';
    constructor(statusCode: number | undefined) {
        super(t('No Set-Cookie header received (status: {0}).', statusCode ?? '?'));
        this.name = 'NoCookieError';
    }
}

/** Determine whether an error is worth retrying. */
function isRetryable(err: Error): boolean {
    const code = (err as NodeJS.ErrnoException).code;
    return (
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        code === 'EPIPE' ||
        code === 'ETIMEDOUT' ||
        err.name === 'NoCookieError'
    );
}

/**
 * Exchange the token URL for an authentication cookie.
 * The returned cookie string is also cached inside the module and can be
 * retrieved via getCookie().
 *
 * isCancelled is checked before every retry: up to 30 attempts at 500ms apart
 * means that without it a "cancel" would not take effect until the whole sequence finished.
 */
export async function exchangeCookie(
    authUrl: string,
    maxAttempts = 30,
    isCancelled?: CancelCheck
): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        throwIfCancelled(isCancelled);

        try {
            dshAuthCookie = await fetchOnce(authUrl);
            return dshAuthCookie;
        } catch (err) {
            const e = err as Error;
            const code = (e as NodeJS.ErrnoException).code;

            if (!isRetryable(e)) {
                throw new Error(t('DSH authentication failed (unrecoverable): {0}', e.message));
            }
            if (attempt === maxAttempts) {
                throw new Error(
                    t('DSH authentication failed after {0} attempts: {1}', attempt, e.message)
                );
            }

            const detail = code || e.message.slice(0, 80);
            log(`[DSH] Cookie fetch failed (${detail}), retry ${attempt}/${maxAttempts}...`);
            await new Promise(r => setTimeout(r, 500));
        }
    }
    // Theoretically unreachable (the loop already throws when attempt === maxAttempts)
    throw new Error(t('DSH authentication failed for an unknown reason.'));
}

/**
 * Single attempt: GET authUrl, extract Set-Cookie from the response headers.
 *
 * DSH's token URL returns 200 + Set-Cookie directly, without a 302 redirect.
 * If it changes to 302 in the future, redirect handling will be needed
 * (http.get does not follow redirects by default).
 */
function fetchOnce(authUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = http.get(authUrl, (res) => {
            const setCookie = res.headers['set-cookie'];
            res.resume();  // Must consume the response body, otherwise the socket is not released

            if (setCookie && setCookie.length > 0) {
                // Only take the "name=value" part, discarding Path/HttpOnly/SameSite etc.
                resolve(setCookie.map(c => c.split(';')[0]).join('; '));
            } else {
                reject(new NoCookieError(res.statusCode));
            }
        });

        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error(t('Timed out waiting for the cookie.'))));
    });
}