import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { pickFreePort, waitForPort } from '../util/port';
import { buildDshEnv } from '../util/env';
import { resolveDshBinPath, resolveNodeExe } from '../util/paths';
import { withPort, parseToken, DEFAULT_PROFILE_ARGS } from '../util/cli';
import { CancelCheck, CancelledError } from '../util/cancel';
import { MissingPathError } from '../util/errors';
import { t } from '../util/l10n';
import { log, logError, logWarn } from '../util/log';
import { redactToken } from '../util/redact';

/**
 * DSH process lifecycle management.
 *
 * Exposes:
 *   startDSH()     — start the process, allocate a port, grab the token; self-clean on failure
 *   stopDSH()      — graceful stop that waits until the process really exits (taskkill / SIGTERM → forced kill on timeout)
 *   killDshSync()  — synchronous forced stop (used during deactivate, must block)
 *   setOnExit()    — register a callback for "unexpected process exit"
 *
 * An intentional stopDSH does not trigger the onExit callback.
 * Unexpected exit (crash, killed, external kill) triggers it; the callback fires only once.
 *
 * Identity check (isCurrent):
 *   A process emits 'exit' exactly once, but by that moment dshProcess may already point at the "next"
 *   process (the restart scenario). If that late event from the old process wrote module state directly, it would blank
 *   the new process reference to undefined, leaving the new process unmanaged: impossible to kill (an orphan),
 *   and it would even spuriously fire the freshly registered onExit callback (showing a bogus "service exited" warning).
 *   Therefore every process event callback first verifies `dshProcess === proc` and returns immediately on a mismatch.
 */

let dshProcess: ChildProcess | undefined;
let dshPort = 0;
let onExitCallback: (() => void) | undefined;

export function isRunning(): boolean { return !!dshProcess; }
export function getPort(): number { return dshPort; }

/**
 * Register the callback for unexpected process exit.
 * The callback fires only once — it is cleared after firing; re-register if needed again.
 */
export function setOnExit(cb: () => void): void {
    onExitCallback = cb;
}

/**
 * Start the DSH process.
 *
 * Returns { port, token } on success; throws on failure.
 * Automatically cleans up the started process on failure — the caller does not need to call stopDSH separately.
 *
 * isCancelled makes both "wait for the token" (up to 120s) and "wait for the port" (up to 30s) cancellable;
 * cancellation cleans up any process that was already spawned, just like a failure does.
 */
export async function startDSH(isCancelled?: CancelCheck): Promise<{ port: number; token: string }> {
    if (dshProcess) {
        throw new Error('DSH process is already running; call stopDSH() first.');
    }

    const binPath = resolveDshBinPath();
    if (!binPath) {
        // A typed error carrying settingId: the caller uses it to offer an "Open settings" button,
        // landing the user on the exact field instead of making them search the settings page.
        throw new MissingPathError(
            t('Could not find the @deepseek-ai/dsh entry point. Make sure it is installed globally, or set the absolute path to lib/bin.js in the dsh.binPath setting.'),
            'dsh.binPath'
        );
    }

    const nodeExe = resolveNodeExe();
    if (!nodeExe) {
        throw new MissingPathError(
            t('Could not find the system node executable. Make sure Node.js is installed, or set its path in the dsh.nodePath setting.'),
            'dsh.nodePath'
        );
    }

    const port = await pickFreePort();
    log('[DSH] Pre-allocated port:', port);

    // Assemble arguments: ensure --port is the value assigned by the extension (overriding any --port in the user config)
    // The exact stripping rules (including the --port=NNNN spelling) live in util/cli.ts as pure functions.
    const config = vscode.workspace.getConfiguration('dsh');
    const baseArgs = config.get<string[]>('args', [...DEFAULT_PROFILE_ARGS]);
    const args = withPort(baseArgs, port);
    log('[DSH] Launch arguments:', args.join(' '));

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

    try {
        const token = await spawnAndWaitForToken(nodeExe, binPath, args, cwd, isCancelled);
        await waitForPort(port, 30000, isCancelled);
        dshPort = port;
        return { port, token };
    } catch (err) {
        // Startup failed: the process may have spawned but be unusable; wait for cleanup before throwing
        await stopDSH();
        throw err;
    }
}

/**
 * Spawn the DSH process and capture the token from stdout.
 *
 * Reject on failure (timeout, process crash, spawn failure), attaching captured
 * stdout/stderr for diagnostics.
 */
function spawnAndWaitForToken(
    nodeExe: string,
    binPath: string,
    args: string[],
    cwd: string,
    isCancelled?: CancelCheck
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const proc = spawn(nodeExe, [binPath, ...args], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildDshEnv(),
            // Unix: make the child the leader of a new process group so a stop can reap the whole tree via -pid
            detached: process.platform !== 'win32'
        });
        dshProcess = proc;

        // Identity check: only events from the currently managed process may mutate module state.
        // See the "Identity check" section in the file header for details.
        const isCurrent = () => dshProcess === proc;

        let stdoutBuf = '';
        let stderrBuf = '';
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let cancelHandle: NodeJS.Timeout | undefined;

        const cleanup = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = undefined;
            }
            if (cancelHandle) {
                clearInterval(cancelHandle);
                cancelHandle = undefined;
            }
        };

        const tryResolve = (t: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(t);
        };

        const tryReject = (msg: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            // The token in the dump must be masked: this text goes to the log and is copied by "Copy Error Details".
            reject(new Error(
                msg +
                `\n\n--- stdout ---\n${redactToken(stdoutBuf) || '(empty)'}` +
                `\n\n--- stderr ---\n${redactToken(stderrBuf) || '(empty)'}`
            ));
        };

        proc.stdout?.on('data', (data: Buffer) => {
            const text = data.toString();
            stdoutBuf += text;
            // The log gets a masked copy; stdoutBuf itself stays raw because parseToken needs it.
            log('[DSH stdout]', redactToken(text.trim()));
            const token = parseToken(stdoutBuf);
            if (token) { tryResolve(token); }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const text = data.toString();
            stderrBuf += text;
            log('[DSH stderr]', redactToken(text.trim()));
        });

        proc.on('error', (err) => {
            if (!isCurrent()) { return; }
            tryReject(t('Could not start the process: {0}', err.message));
        });

        proc.on('exit', (code) => {
            const current = isCurrent();
            if (current) {
                dshProcess = undefined;
                dshPort = 0;
            } else {
                // Late exit event from an old process — never touch the new process state
                log(`[DSH] Process ${proc.pid} exited; no longer supervised, state change ignored`);
            }

            if (!settled) {
                // Exited before the token was obtained — startup failure.
                // Settle the promise either way so the caller can never hang forever.
                tryReject(t('The process exited early (code {0}).', String(code)));
                return;
            }

            if (current && onExitCallback) {
                // Startup completed, then exited while running — notify the upper layer
                const cb = onExitCallback;
                onExitCallback = undefined;
                logError(`[DSH] Process exited unexpectedly (code=${code})`);
                cb();
            }
        });

        timeoutHandle = setTimeout(
            () => tryReject(t('Timed out waiting for the token (120s).')),
            120000
        );

        // Cancellation polling: the token can take up to 120s, and a "cancel" click during that window must exit immediately.
        // Polling rather than threading a CancellationToken in keeps process.ts from caring who is cancelling.
        if (isCancelled) {
            cancelHandle = setInterval(() => {
                if (!isCancelled() || settled) { return; }
                settled = true;
                cleanup();
                // CancelledError rather than a plain Error: the caller uses it to tell "the user gave up"
                // apart from "startup actually failed", and the former deserves no error dialog.
                reject(new CancelledError());
                void stopDSH();
            }, 200);
        }
    });
}

/** Grace period for a graceful stop: escalate to a forced kill after this. */
const GRACE_MS = 3000;

/** Give up waiting this long after the forced kill, so stopDSH can never block forever. */
const FORCE_WAIT_MS = 2000;

/**
 * Graceful stop: send a graceful signal first, escalate to a forced kill if needed, and wait until the process really exits.
 *
 * Why waiting is mandatory:
 *   Returning right after firing taskkill would make the await in restartService meaningless:
 *   the old process could still be running while the new one had already started, leaving two DSH instances alive.
 *
 * onExitCallback is cleared and the dshProcess reference detached first:
 *   this way the process's later exit event is classified as "not current" by the identity check,
 *   so it neither mutates module state nor triggers an "unexpected exit" notification.
 *
 * Windows: taskkill /T /F (forced immediately — a console process has no graceful exit to wait for)
 * Unix:    SIGTERM to the process group (-pid) → SIGKILL to the process group after the grace period
 */
export async function stopDSH(): Promise<void> {
    onExitCallback = undefined;

    const proc = dshProcess;
    if (!proc) { return; }

    const pid = proc.pid;
    dshProcess = undefined;
    dshPort = 0;
    if (!pid) { return; }

    await terminateTree(proc, pid);
}

/** Whether the process already shows signs of having finished (exit code or terminating signal is ready). */
function hasExited(proc: ChildProcess): boolean {
    return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * Terminate the whole process tree and wait for it to exit.
 *
 * It always returns within GRACE_MS + FORCE_WAIT_MS:
 * one stuck process must not block stopAll (and therefore the UI) forever.
 * On the normal path the process exits immediately, so the ceiling is never reached.
 */
function terminateTree(proc: ChildProcess, pid: number): Promise<void> {
    if (hasExited(proc)) { return Promise.resolve(); }

    // On Windows there is no real "graceful stop": node is a console process and taskkill without /F
    // usually just fails, wasting a whole grace period. So Windows force-kills immediately — while still waiting for a real exit.
    const graceful = process.platform !== 'win32';

    return new Promise<void>((resolve) => {
        let done = false;
        let escalateHandle: NodeJS.Timeout | undefined;
        let giveUpHandle: NodeJS.Timeout | undefined;

        const finish = () => {
            if (done) { return; }
            done = true;
            if (escalateHandle) { clearTimeout(escalateHandle); }
            if (giveUpHandle) { clearTimeout(giveUpHandle); }
            proc.removeListener('exit', finish);
            resolve();
        };

        // Attach the exit listener before signalling, so an immediate exit cannot be missed
        proc.once('exit', finish);

        signalTree(pid, !graceful);

        if (graceful) {
            escalateHandle = setTimeout(() => {
                logWarn(`[DSH] Process ${pid} did not exit within ${GRACE_MS}ms; escalating to a forced kill`);
                signalTree(pid, true);
            }, GRACE_MS);
        }
        giveUpHandle = setTimeout(finish, GRACE_MS + FORCE_WAIT_MS);
    });
}

/**
 * Send a stop signal to the whole process tree.
 *
 * taskkill is invoked by absolute path on Windows: the Extension Host's PATH may be
 * incomplete (see util/env.ts), so a bare 'taskkill' risks "command not found".
 */
function signalTree(pid: number, force: boolean): void {
    try {
        if (process.platform === 'win32') {
            const args = ['/PID', String(pid), '/T'];
            if (force) { args.push('/F'); }
            spawn(resolveTaskkillExe(), args, {
                windowsHide: true,
                stdio: 'ignore'
            });
        } else {
            // detached:true makes the child a process-group leader, so -pid addresses the whole group
            process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
        }
    } catch { /* The process may have already exited. */ }
}

/** Absolute path of taskkill.exe, falling back to the bare command name. */
function resolveTaskkillExe(): string {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const exe = path.join(systemRoot, 'System32', 'taskkill.exe');
    try {
        return fs.existsSync(exe) ? exe : 'taskkill';
    } catch {
        return 'taskkill';
    }
}

/**
 * Synchronous forced stop: blocks until the process is killed.
 *
 * Used in deactivate — the Extension Host is about to shut down and there is no time to wait for an asynchronous kill.
 * Must use execSync instead of spawn: after spawn returns the process may still be running,
 * while the Extension Host has already exited, leaving the process orphaned.
 */
export function killDshSync(): void {
    if (!dshProcess?.pid) return;

    const pid = dshProcess.pid;
    dshProcess = undefined;
    dshPort = 0;

    try {
        if (process.platform === 'win32') {
            execSync(`"${resolveTaskkillExe()}" /PID ${pid} /T /F`, {
                stdio: 'ignore',
                timeout: 2000
            });
        } else {
            // Consistent with stopDSH: signal the whole process group so grandchildren are not orphaned
            process.kill(-pid, 'SIGKILL');
        }
    } catch { /* ignore */ }
}