import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import { log, logWarn } from '../util/log';
import { isDocumentRequest } from '../util/html-bridge';
import { pipeWithBridgeInjection } from '../util/inject-stream';
import {
    guardRequest,
    parseCookies,
    SESSION_COOKIE,
    SESSION_PATH_PREFIX,
    scrubSecretFromReferer
} from '../util/proxy-guard';
import { getCookie, reauthenticate } from './auth';

/**
 * Reverse proxy: forward Webview requests to DSH and inject authentication.
 *
 * Why a proxy is needed:
 *   The Webview iframe is a fresh session with no DSH authentication cookie,
 *   so accessing DSH directly returns "authentication required".
 *   The proxy holds the cookie inside the Extension Host and injects it into every request.
 *
 * Handles two kinds of traffic:
 *   1. Plain HTTP — request/response, handled by the http.createServer handler
 *   2. WebSocket — protocol upgrade, handled separately via the 'upgrade' event
 *
 * Three critical header rewrites (missing any one causes DSH to reject):
 *   - Host    → DSH's trust fence checks whether Host points to itself
 *   - Cookie  → passes DSH authentication
 *   - Origin / Referer → DSH's browser-trust fence only trusts its own origin;
 *                        without rewriting, it returns 403
 *
 * Security model (see the header of util/proxy-guard.ts):
 *   This proxy injects authentication and rewrites Origin to a value DSH trusts,
 *   so "whoever can reach this port" equals "whoever holds an authenticated DSH client that can run commands".
 *   Each session generates a random secret; the iframe's first load carries it in the URL and trades it for a cookie,
 *   and every later request (WebSocket included) must present it.
 */

let proxyServer: http.Server | undefined;
let dshAgent: http.Agent | undefined;
let proxyPort = 0;
let targetPort = 0;

/** The random secret for this proxy session, discarded on stopProxy. */
let sessionSecret = '';

/** Every socket we own, forcibly closed by stopProxy. */
const liveSockets = new Set<net.Socket>();

export function isRunning(): boolean { return !!proxyServer; }
export function getProxyPort(): number { return proxyPort; }

/** The proxy's own origin. */
export function getProxyOrigin(): string {
    return proxyPort === 0 ? '' : `http://127.0.0.1:${proxyPort}`;
}

/**
 * The iframe entry URL, carrying the one-time session secret.
 *
 * This rather than the bare origin: the first visit trades the URL secret for a cookie,
 * and only then do later requests pass on the cookie.
 */
export function getEntryUrl(): string {
    if (proxyPort === 0 || sessionSecret === '') { return ''; }
    return `http://127.0.0.1:${proxyPort}${SESSION_PATH_PREFIX}${sessionSecret}`;
}

/**
 * Start the proxy server, listening on a random free port, and return the actual port.
 *
 * If a proxy is already running, throw directly — to avoid accidentally creating a second server
 * which would lose the old reference and leak the port.
 */
export function startProxy(tp: number): Promise<number> {
    if (proxyServer) {
        return Promise.reject(new Error('The proxy server is already running; call stopProxy() first.'));
    }

    targetPort = tp;
    // A 256-bit random secret: a local process can forge any header, but cannot guess this.
    sessionSecret = crypto.randomBytes(32).toString('hex');

    dshAgent = new http.Agent({
        keepAlive: true,
        maxSockets: 50,
        keepAliveMsecs: 30000
    });

    return new Promise((resolve, reject) => {
        const server = http.createServer((clientReq, clientRes) => {
            const outcome = guard(clientReq);
            if (!outcome.ok) {
                rejectRequest(clientRes, outcome.status, outcome.reason, clientReq.headers);
                return;
            }

            if (outcome.bootstrap) {
                serveBootstrap(clientRes);
                return;
            }

            forwardHttp(clientReq, clientRes, false);
        });

        // ---------- WebSocket forwarding ----------
        //
        // When http.Server receives an Upgrade request, it does not go through the normal handler; it fires 'upgrade' instead.
        // At this point the handshake must be completed manually: read raw headers, rewrite them, assemble
        // HTTP/1.1 text, and write it into the TCP connection to DSH.
        //
        // Use rawHeaders instead of headers: preserves the original order and casing of headers,
        // and the WebSocket handshake requires ordering (Upgrade must precede Connection).
        server.on('upgrade', (clientReq, clientSocketRaw, head) => {
            // The http.Server type definition declares the socket as Duplex, but it is actually a net.Socket
            const clientSocket = clientSocketRaw as net.Socket;
            trackSocket(clientSocket);

            // WebSockets go through the same three checks —
            // bypassing it would connect straight to DSH's live channel.
            const outcome = guard(clientReq);
            if (!outcome.ok) {
                log(`[PROXY WS] Rejected upgrade (${outcome.reason})`);
                clientSocket.destroy();
                return;
            }

            const serverSocket = net.connect(targetPort, '127.0.0.1', () => {
                // Disable Nagle's algorithm: small WebSocket messages (trace stream, cursor position, etc.)
                // should not be delayed by packet coalescing.
                clientSocket.setNoDelay(true);
                serverSocket.setNoDelay(true);

                const dshOrigin = `http://127.0.0.1:${targetPort}`;
                const rawHeaders = clientReq.rawHeaders.slice();

                for (let i = 0; i < rawHeaders.length; i += 2) {
                    const name = rawHeaders[i].toLowerCase();
                    if (name === 'host') {
                        rawHeaders[i + 1] = `127.0.0.1:${targetPort}`;
                    } else if (name === 'cookie') {
                        // Replaced wholesale: DSH should only ever see its own authentication cookie,
                        // and our session secret must not leak upstream.
                        rawHeaders[i + 1] = getCookie();
                    } else if (name === 'origin') {
                        rawHeaders[i + 1] = dshOrigin;
                    } else if (name === 'referer') {
                        rawHeaders[i + 1] = scrubSecretFromReferer(
                            String(rawHeaders[i + 1]).replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${targetPort}`),
                            sessionSecret
                        );
                    }
                }

                // If the client did not include a Cookie header, add one
                const hasCookie = rawHeaders.some((h, i) =>
                    i % 2 === 0 && String(h).toLowerCase() === 'cookie');
                const cookie = getCookie();
                if (!hasCookie && cookie) {
                    rawHeaders.push('Cookie', cookie);
                }

                // Manually assemble the HTTP/1.1 handshake text. Cannot use http.request — that path
                // would treat upgrade as a normal request and skip the WebSocket upgrade flow.
                let handshake = `${clientReq.method} ${clientReq.url} HTTP/1.1\r\n`;
                for (let i = 0; i < rawHeaders.length; i += 2) {
                    handshake += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
                }
                handshake += '\r\n';

                serverSocket.write(handshake);
                if (head && head.length) { serverSocket.write(head); }

                // Handshake timeout: when the upstream accepts the connection but never answers, destroy both ends.
                // Without it a socket hangs forever: no visible error, just "it never connects".
                const handshakeTimer = setTimeout(() => {
                    log('[PROXY WS] Upstream handshake timed out; closing the connection');
                    clientSocket.destroy();
                    serverSocket.destroy();
                }, 15000);
                serverSocket.once('data', () => { clearTimeout(handshakeTimer); });
                serverSocket.once('close', () => { clearTimeout(handshakeTimer); });
                clientSocket.once('close', () => { clearTimeout(handshakeTimer); });

                // Bidirectional byte-stream passthrough
                clientSocket.pipe(serverSocket).pipe(clientSocket);
            });
            trackSocket(serverSocket);

            // WebSocket socket errors are sometimes normal (ECONNRESET when the user closes the panel),
            // so use log instead of logError to avoid noise
            serverSocket.on('error', (err) => {
                log('[PROXY WS] serverSocket error:', err.message);
                clientSocket.destroy();
            });
            clientSocket.on('error', (err) => {
                log('[PROXY WS] clientSocket error:', err.message);
                serverSocket.destroy();
            });
        });

        enqueueSockets(server);

        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr === 'object') {
                proxyServer = server;
                proxyPort = addr.port;
                // Log the origin only, never the entry URL — the latter carries the session secret and must not reach the log
                log('[PROXY] Started:', getProxyOrigin());
                resolve(addr.port);
            } else {
                reject(new Error('Could not determine the proxy port.'));
            }
        });

        server.on('error', reject);
    });
}

/** Run the three checks against a request. */
function guard(req: http.IncomingMessage) {
    return guardRequest({
        headers: req.headers,
        requestUrl: req.url ?? '',
        expectedHost: `127.0.0.1:${proxyPort}`,
        expectedOrigin: `http://127.0.0.1:${proxyPort}`,
        sessionSecret
    });
}

/**
 * Response for a failed check.
 *
 * Including the reason code and the names of any cookies received is deliberate: a cross-origin web page
 * cannot read this body (no CORS headers), but when the panel fails to open this single line distinguishes
 * "the cookie was never stored/sent" from "it was sent with the wrong value" — no extra round of guessing.
 *
 * Only cookie NAMES are emitted, never values.
 */
function rejectRequest(
    res: http.ServerResponse,
    status: number,
    reason: string,
    headers?: http.IncomingHttpHeaders
): void {
    const names = Object.keys(parseCookies(headers?.cookie)).sort();
    const detail = headers === undefined
        ? ''
        : `; cookies=[${names.join(',') || 'none'}]`;

    log(`[PROXY] Rejected request (${reason}${detail})`);

    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`DSH proxy rejected the request: ${reason}${detail}`);
}

/**
 * The bootstrap response: trade the URL secret for an HttpOnly cookie, then redirect to a clean path.
 *
 * Both attributes are mandatory — please read this before changing them:
 *
 *   SameSite=None is mandatory; Lax does not work.
 *   SameSite compares the request's site against the site of the TOP-LEVEL document, not the parent frame.
 *   The top-level document is vscode-webview://<uuid>, a different site from 127.0.0.1,
 *   so this iframe is a CROSS-SITE iframe: Lax only carries cookies on top-level navigations,
 *   which means neither the subframe navigation nor any subresource request gets one — the redirect target
 *   is rejected by our own guard.
 *
 *   Secure over plain http works because localhost / 127.0.0.1 are treated as trustworthy origins,
 *   where browsers permit Secure cookies to be set.
 *
 * HttpOnly keeps page scripts from reading the secret; Path=/ covers the whole site.
 * Referrer-Policy: no-referrer keeps the redirect target from receiving a secret-bearing Referer.
 */
function serveBootstrap(res: http.ServerResponse): void {
    res.writeHead(302, {
        'set-cookie': `${SESSION_COOKIE}=${sessionSecret}; Path=/; HttpOnly; Secure; SameSite=None`,
        'referrer-policy': 'no-referrer',
        location: '/'
    });
    res.end();
}

/**
 * Whether a request has no body.
 *
 * Only these are replayed after a 401: a replay has to rebuild the request,
 * and a request with a body has already had it consumed by the first forward — replaying would send an empty body.
 */
function isBodylessRequest(req: http.IncomingMessage): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') { return false; }
    if (req.headers['content-length'] !== undefined) { return false; }
    return req.headers['transfer-encoding'] === undefined;
}

/**
 * The name prefix of DSH's authentication cookie (mirrors `COOKIE_PREFIX` in client-connection).
 *
 * Kept as a constant rather than inlined in the filter: a DSH prefix change needs one edit here,
 * and a wrong prefix shows up right away.
 */
const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-';

/**
 * Whether one Set-Cookie header is DSH's session cookie.
 *
 * Only the name (before `name=`) is compared; the value is never inspected, since it may contain anything.
 */
function isDshAuthCookie(cookie: string): boolean {
    return cookie.trim().toLowerCase().startsWith(DSH_AUTH_COOKIE_PREFIX);
}

/**
 * Forward one HTTP request.
 *
 * A true isRetry means this is the replay after a 401, and the client request body is no longer consumed.
 */
function forwardHttp(clientReq: http.IncomingMessage, clientRes: http.ServerResponse, isRetry: boolean): void {
    const dshOrigin = `http://127.0.0.1:${targetPort}`;

    const forwardHeaders: http.OutgoingHttpHeaders = {
        ...clientReq.headers,
        // Rewrite Host: DSH's trust fence verifies that Host points to itself
        host: `127.0.0.1:${targetPort}`,
        // Inject Cookie: this is the core purpose of the proxy
        cookie: getCookie()
    };

    // Rewrite Origin / Referer: DSH's browser-trust fence only trusts its own origin.
    // Without rewriting, the Webview panel keeps showing "auto-reconnecting" — because both WS and /api
    // requests return 403.
    if (clientReq.headers.origin) {
        forwardHeaders.origin = dshOrigin;
    }
    if (clientReq.headers.referer) {
        forwardHeaders.referer = scrubSecretFromReferer(
            String(clientReq.headers.referer).replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${targetPort}`),
            sessionSecret
        );
    }

    // Document requests get the link bridge injected, so the body must arrive uncompressed.
    // DSH's webserver gzips responses of 1024 bytes or more; without forcing identity
    // we would only get gzip bytes we cannot splice a string into.
    const wantsBridge = isDocumentRequest(clientReq.headers, clientReq.url ?? '');
    if (wantsBridge) {
        forwardHeaders['accept-encoding'] = 'identity';
    }

    const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: targetPort,
        path: clientReq.url,
        method: clientReq.method,
        headers: forwardHeaders,
        agent: dshAgent
    }, (proxyRes) => {
        // When DSH's session cookie expires, a replayable request re-authenticates and tries again.
        if (proxyRes.statusCode === 401 && !isRetry && isBodylessRequest(clientReq)) {
            proxyRes.resume();   // Discard this response; it must be consumed or the socket is not released
            log('[PROXY] Upstream returned 401; re-authenticating and replaying the request');
            void reauthenticate().then((ok) => {
                if (ok) {
                    forwardHttp(clientReq, clientRes, true);
                } else {
                    rejectRequest(clientRes, 401, 'reauth-failed', clientReq.headers);
                }
            });
            return;
        }

        const respHeaders = { ...proxyRes.headers };

        // Only DSH's authentication cookie (`dsh-auth-*`) is dropped; every other cookie passes through.
        //
        // Why not delete them all: DSH's cookie is indeed useless in the webview's storage (the proxy holds it
        // itself), but DSH 0.2.1 added a cookie flow on `/connect` (API cookie, v2), and future UI features may
        // rely on other cookie names; deleting everything would break them silently.
        const setCookie = respHeaders['set-cookie'];
        if (setCookie !== undefined) {
            const kept = setCookie.filter((cookie) => !isDshAuthCookie(cookie));
            if (kept.length > 0) {
                respHeaders['set-cookie'] = kept;
            } else {
                delete respHeaders['set-cookie'];
            }
        }

        // Embedding-related headers are stripped only from the document response we are about to inject into:
        //   - removing CSP wholesale would also strip `sandbox; default-src 'none'` from media/attachment responses,
        //     which is DSH's protection for user content and must be left alone.
        //   - the app shell currently sends neither CSP nor X-Frame-Options (verified across every @deepseek-ai package),
        //     so this step is kept only so a future DSH cannot break the embed.
        if (wantsBridge) {
            delete respHeaders['content-security-policy'];
            delete respHeaders['x-frame-options'];
        }

        if (!wantsBridge) {
            clientRes.writeHead(proxyRes.statusCode || 200, respHeaders);
            proxyRes.pipe(clientRes);
            return;
        }

        // Whether the response can actually be injected (content-type / compression) is decided inside
        pipeWithBridgeInjection(proxyRes, clientRes, respHeaders, logWarn);
    });

    proxyReq.on('error', (err) => {
        if (!clientRes.headersSent) {
            clientRes.writeHead(502);
        }
        clientRes.end(`Proxy error: ${err.message}`);
    });

    if (isRetry) {
        // Replay: the first forward already consumed the body, so piping again would send an empty one
        proxyReq.end();
    } else {
        clientReq.pipe(proxyReq);
    }
}

/** Take ownership of a socket so it can be reclaimed centrally. */
function trackSocket(socket: net.Socket): void {
    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));
}

/** Track every connection the server accepts. */
function enqueueSockets(server: http.Server): void {
    server.on('connection', (socket) => trackSocket(socket));
}

/**
 * Shut down the proxy server and the connection pool.
 *
 * http.Server.close() only "stops accepting new connections"; already-established connections
 * (especially WebSocket long connections) are not forcibly closed, so traffic may keep flowing after a stop.
 * Every socket we own is explicitly destroyed here.
 */
export function stopProxy(): void {
    if (proxyServer) {
        try { proxyServer.close(); } catch { /* ignore */ }
        proxyServer = undefined;
    }
    if (dshAgent) {
        try { dshAgent.destroy(); } catch { /* ignore */ }
        dshAgent = undefined;
    }

    for (const socket of liveSockets) {
        try { socket.destroy(); } catch { /* ignore */ }
    }
    liveSockets.clear();

    proxyPort = 0;
    targetPort = 0;
    // The secret dies with the session; the next start gets a fresh one
    sessionSecret = '';
}
