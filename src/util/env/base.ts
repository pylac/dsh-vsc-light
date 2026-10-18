/**
 * The identity layer: variables the OS injects at logon that are **not** stored in the registry Environment keys.
 *
 * Why this layer exists:
 *   After decoupling, DSH's environment comes from the registry (machine + user) only. But `SystemRoot`,
 *   `USERPROFILE`, `APPDATA` and friends are not in the registry at all: the OS fills them into every
 *   process environment block at logon. Without them Node finds no temp directory, git finds no home,
 *   and DSH itself may fail to start.
 *
 *   Taking the values from the parent instead of hardcoding them:
 *   These values describe who is logged in; they do not vary with how VS Code was launched (VS Code does not
 *   rewrite `USERPROFILE`). Reading them from the parent is accurate and needs no path guessing.
 *
 * This is the only inheritance the extension performs, and only for this allowlist — nothing outside it enters.
 */

/** Variable names the identity layer may read from the parent (Windows case-insensitive). */
export const IDENTITY_VARS: readonly string[] = [
    // System root: nearly every absolute-path expansion depends on it.
    'SystemRoot',
    'windir',

    // Command interpreter and executable suffix list: spawned processes need them to run scripts.
    'ComSpec',
    'PATHEXT',

    // Current user identity and directories: os.homedir(), git, npm, and MCP servers all depend on them.
    'USERPROFILE',
    'USERNAME',
    'USERDOMAIN',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',

    // Program directories: some tools locate their runtime next to them.
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'PUBLIC',
    'ALLUSERSPROFILE',

    // Processor and OS facts: native modules and build scripts read them.
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
    'OS',
    'SESSIONNAME',

    // Temporary directories: the registry usually has them too; this is the fallback (the registry wins).
    'TEMP',
    'TMP'
];

/**
 * Pick the identity layer out of the parent environment.
 *
 * Undefined variables are skipped rather than emitted empty — an empty `APPDATA` is worse than none,
 * because tools would treat the empty string as a valid path.
 *
 * @param source The parent environment (usually `process.env`).
 * @returns A map containing only the allowlisted variables that are defined.
 */
export function pickIdentity(source: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of IDENTITY_VARS) {
        const value = source[name];
        if (value !== undefined && value !== '') { out[name] = value; }
    }
    return out;
}
