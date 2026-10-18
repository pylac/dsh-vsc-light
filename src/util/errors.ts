/**
 * The extension's own error types.
 *
 * Why types rather than message strings:
 *   The caller needs to pick which buttons to offer based on the KIND of failure. "The dsh entry
 *   point was not found" should offer "Open settings" and land the user on the right field,
 *   whereas a settings button for "authentication failed" is meaningless. Matching a Chinese
 *   substring in the message would silently break the next time the copy changes.
 *
 * Kept in util and free of a vscode dependency so it can be constructed and compared outside an
 * extension host.
 */

/**
 * A path probe failed: the dsh entry point or Node.js could not be found.
 */
export class MissingPathError extends Error {
    constructor(
        message: string,
        /** The full id of the setting the user should edit, e.g. dsh.binPath. */
        readonly settingId: string
    ) {
        super(message);
        this.name = 'MissingPathError';
    }
}

/** Whether this is a path-probe failure. */
export function isMissingPathError(err: unknown): err is MissingPathError {
    // As with CancelledError: several copies of the class can exist in build output, so name is a
    // necessary fallback
    return err instanceof MissingPathError
        || (err as Error | undefined)?.name === 'MissingPathError';
}
