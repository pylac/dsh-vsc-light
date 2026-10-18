import * as net from 'net';
import { CancelCheck, throwIfCancelled } from './cancel';
import { t } from './l10n';
import { logWarn } from './log';

/**
 * Request a free port from the operating system.
 *
 * Method: listen on port 0 (let the OS dynamically allocate), read the actual allocated port
 * number, then close. This is the only standard way in Node to "query an available port" — Node
 * has no API to directly query a free port.
 *
 *   There is a TOCTOU (Time-of-Check to Time-of-Use) race condition: between the completion of
 *   close and the caller actually binding the port, there is a tiny window where another process
 *   may grab it (on Windows there may also be lingering TIME_WAIT states). The caller should
 *   verify with waitForPort, or retry on EADDRINUSE.
 *
 * Key point: must wait for the srv.close() callback to fire before resolving, otherwise the port
 * the caller receives is still occupied by the probing server.
 */
export function pickFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object') {
                const p = addr.port;
                srv.close(() => resolve(p));
            } else {
                srv.close(() => reject(new Error('Could not determine the assigned port.')));
            }
        });
    });
}

/**
 * Poll and wait for the port to enter the listening state.
 *
 * Use the lowest-level TCP connection probe — lighter than sending an HTTP request, and
 * unaffected by whether the HTTP handler has finished mounting. As long as the TCP layer can
 * connect, the port is considered bound.
 *
 * Probe interval 250ms (balancing response speed and resource consumption), default timeout 30
 * seconds. Each probe destroys the socket immediately regardless of success or failure, avoiding
 * connection buildup.
 *
 * isCancelled supports cancelling the startup flow: it is checked before every probe, and on
 * cancellation CancelledError is thrown instead of waiting out the timeout.
 */
export function waitForPort(port: number, timeoutMs = 30000, isCancelled?: CancelCheck): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        let attempts = 0;

        const tryOnce = () => {
            try {
                throwIfCancelled(isCancelled);
            } catch (err) {
                reject(err);
                return;
            }

            attempts++;
            const socket = net.connect(port, '127.0.0.1');
            let done = false;

            // Local connections almost never time out; add a defensive threshold to prevent
            // "hanging"
            socket.setTimeout(2000, () => {
                if (done) return;
                done = true;
                socket.destroy();
                scheduleRetry();
            });

            socket.once('connect', () => {
                if (done) return;
                done = true;
                socket.destroy();
                resolve();
            });

            socket.once('error', () => {
                if (done) return;
                done = true;
                socket.destroy();
                scheduleRetry();
            });
        };

        const scheduleRetry = () => {
            if (Date.now() > deadline) {
                reject(new Error(t(
                    'Timed out waiting for port {0} to become ready ({1}ms, {2} attempts).',
                    port, timeoutMs, attempts
                )));
                return;
            }
            // Log progress every 4 attempts (about 1 second) to avoid flooding the log
            if (attempts % 4 === 0) {
                logWarn(`[PORT] Waiting for ${port} to become ready (${attempts} attempts so far)...`);
            }
            setTimeout(tryOnce, 250);
        };

        tryOnce();
    });
}