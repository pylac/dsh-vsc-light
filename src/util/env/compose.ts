/**
 * Environment composition: merge order, `%VAR%` expansion, and PATH assembly.
 *
 * Why this is a standalone, side-effect-free module:
 *   These three are the error-prone parts (layer precedence, casing, expansion order, PATH dedupe), and none of
 *   them needs a child process or the registry — extracting them keeps them verifiable outside an extension
 *   host.
 *
 * Convention: this module is used on Windows only, so variable names follow Windows casing rules (insensitive).
 */

/** A plain environment map. */
export type EnvMap = Record<string, string>;

/** The three layers feeding composition. */
export interface ComposeInput {
    /**
     * The identity layer: variables injected by the OS at logon rather than stored in the registry
     * (user directories, system directories, processor facts).
     */
    identity: EnvMap;
    /** Machine-level registry environment; values may contain unexpanded `%VAR%`. */
    machine: EnvMap;
    /** User-level registry environment; values may contain unexpanded `%VAR%`. */
    user: EnvMap;
}

/** The composition result. */
export interface ComposeResult {
    /** The final environment. */
    env: EnvMap;
    /** Anomalies worth logging (unconverged expansion, PATH falling back to the parent, …). */
    warnings: string[];
}

/** Windows variable names are case-insensitive: every lookup goes through an uppercased key. */
function keyOf(name: string): string {
    return name.toUpperCase();
}

/** Read a value case-insensitively; an absent value is the empty string. */
function get(map: EnvMap, name: string): string {
    const key = keyOf(name);
    for (const [name2, value] of Object.entries(map)) {
        if (keyOf(name2) === key) { return value; }
    }
    return '';
}

/**
 * Merge layers in order; later layers override earlier ones.
 *
 * The **first spelling wins**: the registry commonly has `Path` while the parent has `PATH`,
 * and emitting both would put duplicate names into the child's environment block.
 */
function mergeLayers(layers: readonly EnvMap[]): Map<string, { name: string; value: string }> {
    const out = new Map<string, { name: string; value: string }>();
    for (const layer of layers) {
        for (const [name, value] of Object.entries(layer)) {
            const key = keyOf(name);
            const existing = out.get(key);
            out.set(key, { name: existing === undefined ? name : existing.name, value });
        }
    }
    return out;
}

/** An expansion placeholder of the form `%NAME%`. */
const EXPANSION_PATTERN = /%([^%]+)%/g;

/**
 * Upper bound on expansion passes.
 *
 * A variable may reference another (a user variable referencing a machine one), and one pass can produce new
 * placeholders, so passes iterate until stable. The bound gives mutual references (A→B→A) a definite stop.
 */
const MAX_EXPANSION_PASSES = 5;

/**
 * Expand every value in place.
 *
 * An unknown `%NAME%` is left verbatim: it may be some tool's own syntax, and guessing is worse than keeping it.
 */
function expandValues(entries: Map<string, { name: string; value: string }>, warnings: string[]): void {
    for (let pass = 0; pass < MAX_EXPANSION_PASSES; pass++) {
        let changed = false;
        for (const entry of entries.values()) {
            entry.value = entry.value.replace(EXPANSION_PATTERN, (whole, name: string) => {
                const target = entries.get(keyOf(name));
                if (target === undefined || target.value === '') { return whole; }
                changed = true;
                return target.value;
            });
        }
        if (!changed) { return; }
    }
    warnings.push('Environment expansion did not converge (circular reference); keeping the last pass');
}

/**
 * The PATH dedupe key ignores trailing directory separators.
 *
 * `C:\Tools\Node\` and `C:\Tools\Node` are the same directory, and keeping both only lengthens PATH and makes it
 * hard to count while debugging — registry entries frequently carry one.
 *
 * A drive root `C:\` would become `C:` — the legacy meaning "current directory" — so it must be preserved.
 */
function pathKey(value: string): string {
    const stripped = value.replace(/[\\/]+$/, '');
    if (stripped === '') { return keyOf(value); }
    if (/^[A-Za-z]:$/.test(stripped)) { return keyOf(`${stripped}\\`); }
    return keyOf(stripped);
}

/**
 * Expand and deduplicate PATH.
 *
 * Order must be preserved: Windows PATH is first-hit-wins, and reordering would change which tool a name selects.
 * Duplicates are removed case-insensitively (Windows paths are insensitive too).
 */
function normalizePath(raw: string, warnings: string[]): string {
    if (raw === '') { return ''; }
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const part of raw.split(';')) {
        const trimmed = part.trim();
        if (trimmed === '') { continue; }
        const key = pathKey(trimmed);
        if (seen.has(key)) { continue; }
        seen.add(key);
        parts.push(trimmed);
    }
    if (parts.length === 0) { warnings.push('PATH has no valid entries after expansion'); }
    return parts.join(';');
}

/**
 * Compose the final environment.
 *
 * Rules (see "How the DSH child process is launched" in the README):
 *   1. identity → machine → user, each overriding the previous;
 *   2. PATH does not take part in layer precedence: it is always "machine PATH;user PATH";
 *   3. every value is expanded from the composed map, not from the parent environment;
 *   4. the identity PATH is used only when both registry layers lack one, and that leaves a warning.
 *
 * @param input The three layers.
 * @returns The final environment plus anomalies worth logging.
 */
export function composeEnvironment(input: ComposeInput): ComposeResult {
    const warnings: string[] = [];

    const identityPath = get(input.identity, 'PATH');
    const machinePath = get(input.machine, 'PATH');
    const userPath = get(input.user, 'PATH');
    const registryPath = [machinePath, userPath].filter((part) => part !== '').join(';');
    const rawPath = registryPath !== '' ? registryPath : identityPath;
    if (registryPath === '' && identityPath !== '') {
        warnings.push('No PATH in the registry; falling back to the parent PATH');
    }

    const merged = mergeLayers([input.identity, input.machine, input.user]);

    // The composed PATH overrides whatever the layers produced: precedence does not apply to PATH.
    if (rawPath === '') {
        merged.delete('PATH');
    } else {
        const existing = merged.get('PATH');
        merged.set('PATH', { name: existing === undefined ? 'Path' : existing.name, value: rawPath });
    }

    expandValues(merged, warnings);

    const env: EnvMap = {};
    for (const { name, value } of merged.values()) {
        env[name] = value;
    }

    const pathEntry = merged.get('PATH');
    if (pathEntry !== undefined) {
        // Expansion ran after the join, so this is the fully expanded PATH.
        env.Path = normalizePath(pathEntry.value, warnings);
        // Spelling is normalized to `Path`: Windows is insensitive, but two spellings in one environment block
        // only make debugging harder.
        if (pathEntry.name !== 'Path') { delete env[pathEntry.name]; }
    }

    return { env, warnings };
}
