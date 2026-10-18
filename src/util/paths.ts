import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Locate the paths of dsh and node.exe.
 *
 * Probing strategy (priority from high to low):
 *   1. User configuration (dsh.binPath / dsh.nodePath) — covers non-standard installations
 *   2. Environment variables (DSH_BIN_PATH / DSH_NODE_PATH) — convenient for script injection
 *   3. Zero-cost candidate directories (%APPDATA%\npm, etc.) — hits common installations
 *   4. High-cost probing (npm config get prefix / where node) — covers modified default paths
 *   5. Hardcoded candidate paths — final fallback
 *
 * Returns null if all fail; the caller decides how to notify the user.
 *
 * All results are cached — these paths do not change during the extension lifecycle, so there is
 * no need to re-probe on each DSH restart (avoiding repeated spawn of npm / where processes).
 */

const DSH_RELATIVE_PATH = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

let cachedDshBinPath: string | null | undefined;
let cachedNodeExe: string | null | undefined;

/**
 * Drop the probe cache.
 *
 * Why this is required:
 *   The cache exists so that restarting DSH does not re-spawn npm / where every time, but it also
 *   means that "fail, fill in the right path in settings, retry" keeps failing until the window is
 *   reloaded — and reloading the window is not an action someone who just installed the extension
 *   would think of. Clearing the cache on a configuration change is what makes that path work.
 */
export function invalidatePathCache(): void {
    cachedDshBinPath = undefined;
    cachedNodeExe = undefined;
}

/**
 * Locate the entry file of dsh (lib/bin.js).
 *
 * Probing order (see the file header comment). Returns null if all strategies fail.
 */
export function resolveDshBinPath(): string | null {
    if (cachedDshBinPath !== undefined) return cachedDshBinPath;
    cachedDshBinPath = probeDshBinPath();
    return cachedDshBinPath;
}

function probeDshBinPath(): string | null {
    // 1. User configuration
    const config = vscode.workspace.getConfiguration('dsh');
    const userPath = config.get<string>('binPath', '').trim();
    if (userPath && fs.existsSync(userPath)) return userPath;

    // 2. Environment variable
    const envPath = process.env.DSH_BIN_PATH?.trim();
    if (envPath && fs.existsSync(envPath)) return envPath;

    // 3. Zero-cost candidate: default location of npm global installation
    const quickPrefixes: string[] = [];
    if (process.platform === 'win32' && process.env.APPDATA) {
        quickPrefixes.push(path.join(process.env.APPDATA, 'npm'));
    }
    for (const prefix of quickPrefixes) {
        const candidate = path.join(prefix, DSH_RELATIVE_PATH);
        if (fs.existsSync(candidate)) return candidate;
    }

    // 4. High-cost probing: query the npm global prefix
    //    Only pay this cost when the zero-cost candidates miss
    try {
        const npmPrefix = execSync('npm config get prefix', {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
        }).trim();
        if (npmPrefix && !quickPrefixes.includes(npmPrefix)) {
            const candidate = path.join(npmPrefix, DSH_RELATIVE_PATH);
            if (fs.existsSync(candidate)) return candidate;
        }
    } catch { /* ignore */ }

    return null;
}

/**
 * Locate the system node.exe (note: not the one bundled with VS Code).
 *
 * Why explicitly find node instead of using process.execPath:
 *   process.execPath in the Extension Host points to Code.exe (Electron), while dsh requires a
 *   real Node runtime — Electron's Node lacks certain CLI arguments (e.g., --expose-internals),
 *   which causes dsh startup to fail.
 *
 * Priority is the same as resolveDshBinPath: config > env var > where/which > hardcoded
 * candidates.
 */
export function resolveNodeExe(): string | null {
    if (cachedNodeExe !== undefined) return cachedNodeExe;
    cachedNodeExe = probeNodeExe();
    return cachedNodeExe;
}

function probeNodeExe(): string | null {
    // 1. User configuration
    const config = vscode.workspace.getConfiguration('dsh');
    const userPath = config.get<string>('nodePath', '').trim();
    if (userPath && fs.existsSync(userPath)) return userPath;

    // 2. Environment variable
    const envPath = process.env.DSH_NODE_PATH?.trim();
    if (envPath && fs.existsSync(envPath)) return envPath;

    // 3. where node / which node — the first available node in PATH
    //    Note: the output must be node or node.exe, never Code.exe
    try {
        const cmd = process.platform === 'win32' ? 'where node' : 'which node';
        const out = execSync(cmd, {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
        }).trim();
        for (const line of out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
            if (fs.existsSync(line)) return line;
        }
    } catch { /* ignore */ }

    // 4. Hardcoded candidates — cover the extreme case where PATH does not contain node at all
    const candidates: string[] = [];
    if (process.platform === 'win32') {
        if (process.env.ProgramFiles) {
            candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
        }
        if (process.env['ProgramFiles(x86)']) {
            candidates.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'));
        }
    } else {
        candidates.push('/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node');
    }
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }

    return null;
}