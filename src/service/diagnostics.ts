/**
 * "Copy Diagnostics": gather the facts needed to diagnose "it does not work" onto the clipboard.
 *
 * Why this exists:
 *   Machine-specific failures are invisible in the code — a missing dsh, the wrong node, a degraded environment,
 *   a token timeout, a proxy that never started. When someone reports "it does not work", those facts only arrive
 *   after several rounds of questions; one copy saves the round trips.
 *
 * What is deliberately not collected:
 *   Environment variable **values** (only the source and counts), tokens (already masked), conversation content,
 *   session ids, and file contents.
 *
 * Redaction:
 *   The user's home directory inside paths becomes `%USERPROFILE%`: the structure survives (what matters is
 *   which prefix something is installed under) without putting an account name into a public issue.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as dshProc from './process';
import * as proxy from './proxy';
import { DEFAULT_PROFILE_ARGS, withPort } from '../util/cli';
import { getEnvSummary } from '../util/env';
import { t } from '../util/l10n';
import { log } from '../util/log';
import { resolveDshBinPath, resolveNodeExe } from '../util/paths';

/** The context injected at activation; the diagnostics command can run at any time afterwards. */
let extensionContext: vscode.ExtensionContext | undefined;

/** The first line of the last startup failure (already masked); empty when nothing failed. */
let lastError = '';

/** Keep the context for the diagnostics command. */
export function initDiagnostics(context: vscode.ExtensionContext): void {
    extensionContext = context;
}

/**
 * Record the last error so the report can quote it.
 *
 * Only the first line is kept: the full stack belongs in the log, while the report wants a symptom one can quote.
 */
export function recordLastError(message: string): void {
    const firstLine = message.split(/\r?\n/)[0].trim();
    if (firstLine !== '') { lastError = firstLine.slice(0, 300); }
}

/**
 * Read the dsh version from the install manifest.
 *
 * Not `dsh --version`: that spawns another process (about a second), and the version sits in the package.json
 * two levels above bin.js.
 */
function readDshVersion(binPath: string | null): string {
    if (binPath === null) { return '(not found)'; }
    try {
        const manifestPath = path.join(path.dirname(binPath), '..', 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: unknown };
        return typeof manifest.version === 'string' ? manifest.version : '(unknown)';
    } catch {
        return '(unknown)';
    }
}

/** Replace the user's home directory with `%USERPROFILE%` (case-insensitive). */
function redactHome(text: string): string {
    const home = os.homedir();
    if (home === '') { return text; }
    const pattern = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return text.replace(pattern, '%USERPROFILE%');
}

/**
 * Format the environment summary as one line.
 */
function describeEnv(): string {
    const summary = getEnvSummary();
    if (summary === undefined) { return 'not built yet'; }
    if (summary.source === 'inherited') { return `inherited from the parent (non-Windows), PATH entries ${String(summary.pathEntries)}`; }
    if (summary.source === 'fallback') { return `fallback: identity variables + parent PATH, PATH entries ${String(summary.pathEntries)}`; }
    return `registry (machine ${String(summary.machine)}, user ${String(summary.user)}), PATH entries ${String(summary.pathEntries)}`;
}

/**
 * Local time plus the UTC offset (ISO 8601), e.g. `2026-10-18T21:54:01+08:00`.
 *
 * Why not `toISOString()`: that returns UTC, which reads eight hours off from the user's own clock and invites
 * "is this report stale?". Keeping the offset in the string still lets any reader convert it to UTC, so nothing
 * is lost.
 */
function localTimestamp(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absolute = Math.abs(offsetMinutes);
    const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
    return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

/**
 * Build the diagnostics report (read-only, no side effects).
 *
 * Exported separately so its content can be reviewed line by line before it goes into an issue.
 */
export function buildDiagnosticsReport(): string {
    const binPath = resolveDshBinPath();
    const nodeExe = resolveNodeExe();
    const configured = vscode.workspace.getConfiguration('dsh').get<string[]>('args', [...DEFAULT_PROFILE_ARGS]);
    const running = dshProc.isRunning();
    const args = running
        ? withPort(configured, dshProc.getPort()).join(' ')
        : `${configured.join(' ')} (not started)`;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const workspace = folders.length === 0
        ? 'none'
        : folders.length === 1 ? 'single root' : `multi-root (${String(folders.length)} folders)`;

    const lines = [
        'dsh-vsc-light diagnostics',
        `generated  : ${localTimestamp(new Date())}`,
        `extension  : ${extensionContext === undefined ? '(unknown)' : String(extensionContext.extension.packageJSON.version)}`,
        `vscode     : ${vscode.version}`,
        `os         : ${os.platform()} ${os.release()} ${os.arch()}`,
        `node       : ${process.version}`,
        `dsh        : ${readDshVersion(binPath)}`,
        `dsh entry  : ${binPath ?? '(not found)'}`,
        `node exe   : ${nodeExe ?? '(not found)'}`,
        `args       : ${args}`,
        `service    : ${running ? `running, 127.0.0.1:${String(dshProc.getPort())}` : 'stopped'}`,
        `proxy      : ${proxy.isRunning() ? `running, ${proxy.getProxyOrigin()}` : 'stopped'}`,
        `env        : ${describeEnv()}`,
        `workspace  : ${workspace}`,
        `last error : ${lastError === '' ? '(none)' : lastError}`
    ];

    return redactHome(lines.join('\n'));
}

/**
 * Build the diagnostics report and copy it to the clipboard.
 *
 * A failed copy is reported too: failing silently looks like a dead button and adds another debugging round.
 */
export async function copyDiagnostics(): Promise<void> {
    const report = buildDiagnosticsReport();
    try {
        await vscode.env.clipboard.writeText(report);
        void vscode.window.showInformationMessage(t('Diagnostics copied to the clipboard.'));
    } catch (err) {
        log(`[DIAG] Copying the diagnostics report failed: ${String(err)}`);
        void vscode.window.showWarningMessage(t('Could not copy the diagnostics report.'));
    }
}
