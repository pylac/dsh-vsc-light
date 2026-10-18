/**
 * The "buffer → inject the link bridge → recompute length → send" response pipeline.
 *
 * Why this is its own module:
 *   This is the most error-prone part of the whole link fix (rewriting content-length, dropping
 *   the etag, the over-limit fallback, and the "writeHead exactly once" constraint), and it has no
 *   vscode dependency at all — extracting it makes the pipeline verifiable over a real socket
 *   without booting VS Code.
 *
 * Why buffering is mandatory: injection changes the body length, so content-length must be
 * recomputed, and a streaming pipe never sees the whole body.
 */

import * as http from 'http';
import { injectBridge, MAX_INJECT_BYTES } from './html-bridge';

/** Diagnostic sink injected by the caller, so this module needs no logging channel. */
export type WarnFn = (message: string) => void;

/**
 * Whether an upstream response may be injected into.
 *
 * Both conditions are required:
 *   - content-type is text/html: otherwise the body is not HTML and splicing a string would
 *     corrupt it
 *   - not compressed: we send accept-encoding: identity for document requests, but upstream may
 *     still compress (config changed, served from cache), in which case the body is gzip bytes
 *     and splicing would corrupt it
 */
export function isInjectableResponse(contentType: string, contentEncoding: string): boolean {
    const type = contentType.toLowerCase();
    const encoding = contentEncoding.toLowerCase();
    const compressed = encoding !== '' && encoding !== 'identity';

    return type.startsWith('text/html') && !compressed;
}

/**
 * Forward an upstream response to the client, injecting the link bridge script when needed.
 *
 * The caller only decides "is this a document request"; whether the response can be injected is
 * decided here, so the decision and the execution live together and cannot drift apart.
 *
 * Past MAX_INJECT_BYTES we give up: flush what has been buffered and stream the rest. One
 * un-injected page beats stalling the whole panel in memory.
 */
export function pipeWithBridgeInjection(
    proxyRes: http.IncomingMessage,
    clientRes: http.ServerResponse,
    respHeaders: http.OutgoingHttpHeaders,
    warn: WarnFn
): void {
    const contentType = String(proxyRes.headers['content-type'] ?? '');
    const contentEncoding = String(proxyRes.headers['content-encoding'] ?? '');

    if (!isInjectableResponse(contentType, contentEncoding)) {
        // Straight passthrough: not even the headers are touched
        clientRes.writeHead(proxyRes.statusCode || 200, respHeaders);
        proxyRes.pipe(clientRes);
        return;
    }

    // Let Node decide the framing: we may rewrite the body, and a stale chunked header only gets
    // in the way
    delete respHeaders['transfer-encoding'];

    const chunks: Buffer[] = [];
    let size = 0;
    let gaveUp = false;
    let headersSent = false;

    const sendHead = () => {
        if (headersSent) { return; }
        headersSent = true;
        clientRes.writeHead(proxyRes.statusCode || 200, respHeaders);
    };

    // Stop buffering and abandon upstream reads when the client disconnects mid-flight (panel
    // closed, reload).
    //
    // Without this branch the whole HTML page is still buffered and then written into a closed
    // response: wasted memory, and write errors would be indistinguishable from a real upstream
    // failure in the log. `writableEnded` distinguishes the ordinary close that follows a normal
    // end.
    clientRes.on('close', () => {
        if (clientRes.writableEnded) { return; }
        chunks.length = 0;
        proxyRes.destroy();
    });

    proxyRes.on('data', (chunk: Buffer) => {
        if (gaveUp) {
            // Injection was abandoned: every remaining byte must be forwarded untouched.
            // A bare `return` here would turn "skip buffering" into "drop the data" and silently
            // truncate any page over the limit.
            // A false return means the downstream is saturated; pause upstream until drain so
            // memory cannot balloon.
            if (!clientRes.write(chunk)) {
                proxyRes.pause();
                clientRes.once('drain', () => proxyRes.resume());
            }
            return;
        }

        size += chunk.length;
        if (size > MAX_INJECT_BYTES) {
            warn(`[PROXY] HTML response exceeds ${MAX_INJECT_BYTES} bytes; skipping the link-bridge injection`);
            gaveUp = true;
            sendHead();
            for (const buffered of chunks) { clientRes.write(buffered); }
            chunks.length = 0;
            clientRes.write(chunk);
            return;
        }

        chunks.push(chunk);
    });

    proxyRes.on('end', () => {
        // The client is gone: do not render or write (writeHead on a destroyed response throws).
        if (clientRes.destroyed) { return; }

        if (gaveUp) {
            clientRes.end();
            return;
        }

        const body = injectBridge(Buffer.concat(chunks).toString('utf8'));
        const buf = Buffer.from(body, 'utf8');

        // The body changed, so the length must be recomputed and the etag must go — a stale etag
        // would let the browser reuse an un-injected cached copy via 304, and links would break
        // again.
        delete respHeaders['etag'];
        respHeaders['content-length'] = String(buf.length);

        sendHead();
        clientRes.end(buf);
    });

    proxyRes.on('error', (err) => {
        // A destroy caused by the client closing lands here: not a failure, so log nothing and
        // write nothing.
        if (clientRes.destroyed) { return; }
        warn(`[PROXY] Failed to read the HTML response: ${err.message}`);
        if (!headersSent) {
            clientRes.writeHead(502);
        }
        clientRes.end();
    });
}
