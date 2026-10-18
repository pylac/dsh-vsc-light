/**
 * The single entry point for the DSH child process environment.
 *
 * Contract (the README's "How the DSH child process is launched" section mirrors this):
 *   Windows: environment = identity layer + registry machine + registry user; PATH = machine PATH;user PATH.
 *   The extension **adds no directories**, injects no product variables, and offers no pass-through allowlist —
 *   not finding `code`/`python`/`java` is a machine-configuration matter, not the extension's.
 *   Non-Windows: there is no registry equivalent, so the parent environment is inherited (Electron markers are
 *   removed below).
 *
 * Degradation: an unreadable registry yields "identity layer + parent PATH" plus a warning, never a silent
 * fallback to full inheritance, which would make provenance unexplainable again.
 */

import { log, logWarn } from '../log';
import { pickIdentity } from './base';
import { composeEnvironment, type EnvMap } from './compose';
import { readRegistryEnvironment } from './probe';

/**
 * Variables injected by VS Code / Electron.
 *
 * They cannot appear on Windows after decoupling; removing them matters only on non-Windows, where the parent
 * environment is inherited — a child that later calls `code` would otherwise run it as a Node interpreter
 * instead of opening a window.
 */
const ELECTRON_VARS = [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
    'ELECTRON_ENABLE_LOGGING',
    'ELECTRON_ENABLE_STACK_DUMPING',
    'ELECTRON_DEFAULT_ERROR_MODE'
] as const;

/** The number of real PATH entries, for logging only. */
function countPathEntries(value: string): number {
    return value.split(';').filter((part) => part.trim() !== '').length;
}

/**
 * The facts about the last build, for the diagnostics command.
 *
 * Only the layer and counts are kept, never a value: values are the user's own data and would end up in a
 * clipboard the moment someone copies a diagnostic report.
 */
export interface EnvSummary {
    /** Where the environment came from: registry, degraded fallback, or non-Windows inheritance. */
    readonly source: 'registry' | 'fallback' | 'inherited';
    /** Machine-level registry entry count (meaningful for registry only). */
    readonly machine: number;
    /** User-level registry entry count (meaningful for registry only). */
    readonly user: number;
    /** The number of real entries in the final PATH. */
    readonly pathEntries: number;
}

let lastSummary: EnvSummary | undefined;

/**
 * The facts about the last build, or undefined before the first build.
 */
export function getEnvSummary(): EnvSummary | undefined {
    return lastSummary;
}

/**
 * The degraded environment: identity layer plus the parent PATH.
 *
 * Why only PATH degrades and nothing else is inherited: full inheritance would make provenance
 * situational again — exactly what decoupling removes.
 */
function degrade(identity: EnvMap): NodeJS.ProcessEnv {
    const parentPath = process.env.Path ?? process.env.PATH ?? '';
    logWarn('[ENV] degraded: identity variables + parent PATH (no directory appended)');
    return { ...identity, Path: parentPath };
}

/**
 * Build the environment for the DSH child process.
 *
 * Called once per DSH start; the registry probe is cached in its module, so repeated calls do not re-spawn
 * PowerShell.
 *
 * @returns An environment object ready for `spawn(..., { env })`.
 */
export function buildDshEnv(): NodeJS.ProcessEnv {
    const identity = pickIdentity(process.env);

    if (process.platform !== 'win32') {
        const inherited: NodeJS.ProcessEnv = { ...process.env };
        for (const name of ELECTRON_VARS) { delete inherited[name]; }
        lastSummary = {
            source: 'inherited',
            machine: 0,
            user: 0,
            pathEntries: countPathEntries(inherited.Path ?? '')
        };
        log('[ENV] source=parent process (non-Windows; no registry equivalent)');
        return inherited;
    }

    const probe = readRegistryEnvironment(identity);
    if (!probe.ok) {
        logWarn(`[ENV] Reading the registry environment failed: ${probe.reason}`);
        const degraded = degrade(identity);
        lastSummary = {
            source: 'fallback',
            machine: 0,
            user: 0,
            pathEntries: countPathEntries(String(degraded.Path ?? ''))
        };
        return degraded;
    }

    const { env, warnings } = composeEnvironment({
        identity,
        machine: probe.environment.machine,
        user: probe.environment.user
    });
    for (const warning of warnings) { logWarn(`[ENV] ${warning}`); }

    lastSummary = {
        source: 'registry',
        machine: Object.keys(probe.environment.machine).length,
        user: Object.keys(probe.environment.user).length,
        pathEntries: countPathEntries(env.Path ?? '')
    };
    log(
        '[ENV] source=registry (machine ' + String(lastSummary.machine) +
        ' entries, user ' + String(lastSummary.user) +
        ' entries), PATH entries ' + String(lastSummary.pathEntries)
    );
    return env;
}
