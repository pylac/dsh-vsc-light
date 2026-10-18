/**
 * Read the machine-level and user-level environment from the Windows registry.
 *
 * Why the registry:
 *   Windows exposes no API for "the system environment"; the authoritative source is the two registry keys:
 *     HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment   (machine)
 *     HKCU\Environment                                                    (user)
 *   A process's environment block is a snapshot taken at logon, so inheriting the parent does not yield the
 *   current system configuration.
 *
 * Why values are not expanded here:
 *   A user variable may reference a machine one (`%JAVA_HOME%`), so expansion has to happen after the three
 *   layers are merged, from the composed map — not from the parent environment. That logic lives in
 *   compose.ts as a pure function.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The two raw layers read from the registry. */
export interface RegistryEnvironment {
    machine: Record<string, string>;
    user: Record<string, string>;
}

/** Probe result: the two layers on success, a readable reason on failure. */
export type ProbeResult =
    | { readonly ok: true; readonly environment: RegistryEnvironment }
    | { readonly ok: false; readonly reason: string };

/** Cache: the registry does not change during an extension's lifetime, and re-spawning PowerShell is pointless. */
let cached: ProbeResult | undefined;

/**
 * PowerShell script: emit each key's content as one line of compact JSON.
 *
 * Passed via `-EncodedCommand` (Base64/UTF-16LE) to sidestep quoting, newline, and CJK escaping on the command line.
 *
 * The first line forces UTF-8 output: when redirected to a pipe PowerShell defaults to the console code page
 * (GBK on a Chinese system), and a PATH containing Chinese would be decoded as mojibake by execFileSync.
 *
 * `PS*` properties are skipped: Get-ItemProperty adds PSPath / PSDrive / PSProvider and similar metadata.
 */
const SCRIPT = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    "$ErrorActionPreference='Stop'",
    "$m=Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'",
    '$h=@{}',
    "$m.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $h[$_.Name]=[string]$_.Value }",
    '$h | ConvertTo-Json -Compress',
    "$u=Get-ItemProperty 'HKCU:\\Environment' -ErrorAction SilentlyContinue",
    '$h2=@{}',
    "if ($null -ne $u) { $u.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $h2[$_.Name]=[string]$_.Value } }",
    '$h2 | ConvertTo-Json -Compress'
].join('\n');

/**
 * The probe process's own environment: the identity layer plus a PATH just large enough to start PowerShell.
 *
 * The final environment is deliberately not reused: the probe can fail (there is then no final environment),
 * and PowerShell starts from an absolute path anyway, so this PATH only serves relative dependencies.
 */
function probeEnv(identity: Record<string, string>): NodeJS.ProcessEnv {
    const systemRoot = identity.SystemRoot ?? identity.windir ?? 'C:\\Windows';
    return {
        ...identity,
        PATH: [path.join(systemRoot, 'System32'), path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
    };
}

/**
 * Absolute path to PowerShell; falls back to bare `powershell.exe` when missing.
 */
function resolvePowerShell(systemRoot: string): string {
    const exe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
        return fs.existsSync(exe) ? exe : 'powershell.exe';
    } catch {
        return 'powershell.exe';
    }
}

/** Parse one PowerShell JSON line into a string map; an empty object `{}` is valid. */
function parseLayer(line: string): Record<string, string> | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { return undefined; }

    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') { out[name] = value; }
    }
    return out;
}

/**
 * Read the registry environment (successes are cached).
 *
 * Failures do not throw: the caller decides whether to degrade or give up, and an exception would hide that
 * decision in a call stack.
 *
 * Why failures are not cached:
 *   The probe can fail **transiently** (a busy system right after a window reload, a first antivirus scan,
 *   a cold PowerShell start timing out), and caching that failure would amplify one bad moment into "degraded
 *   for the rest of this extension host, recoverable only by reloading the window".
 *   The price: when PowerShell is permanently unusable, every start pays the probe cost (a few hundred
 *   milliseconds normally, up to the 2-second timeout when it hangs).
 *
 * Success is still cached: the registry does not change during an extension host's lifetime, so re-spawning
 * PowerShell would be pointless.
 *
 * @param identity The identity layer, used to build the probe process's minimal environment.
 * @returns The probe result; callers usually degrade on failure and try again on the next start.
 */
export function readRegistryEnvironment(identity: Record<string, string>): ProbeResult {
    if (cached !== undefined) { return cached; }

    const systemRoot = identity.SystemRoot ?? identity.windir ?? 'C:\\Windows';
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');

    let stdout = '';
    try {
        stdout = execFileSync(resolvePowerShell(systemRoot), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
            encoding: 'utf8',
            // 2 seconds: a probe normally takes a few hundred milliseconds, so there is ample margin. The call is
            // synchronous and blocks the extension host, so a shorter timeout is better: it only bounds a hung
            // probe, which the normal path never reaches. Failures are not cached either, so a false timeout
            // costs one degraded start and retries.
            timeout: 2000,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            env: probeEnv(identity)
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: message.split('\n')[0] };
    }

    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    if (lines.length < 2) {
        return { ok: false, reason: `PowerShell produced only ${lines.length} line(s)` };
    }

    const machine = parseLayer(lines[lines.length - 2]);
    const user = parseLayer(lines[lines.length - 1]);
    if (machine === undefined || user === undefined) {
        return { ok: false, reason: 'PowerShell output is not the expected JSON' };
    }

    cached = { ok: true, environment: { machine, user } };
    return cached;
}
