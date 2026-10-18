/**
 * Cancellation for the startup flow.
 *
 * Why this is needed:
 *   Opening a panel can take up to 120s (waiting for the token) + 30s (waiting for the port) +
 *   auth retries, and the whole chain is awaits. Without cancellation the user has no choice but
 *   to wait it out, unable even to dismiss the progress notification.
 *
 * A plain `() => boolean` rather than vscode.CancellationToken:
 *   the util layer (port.ts and friends) deliberately does not depend on vscode, and passing a
 *   function keeps it both verifiable on its own and trivially wired to a token.
 */
import { t } from './l10n';

/** Ask "has this been cancelled?". */
export type CancelCheck = () => boolean;

/**
 * A failure caused by cancellation.
 *
 * A distinct type lets the caller tell "the user gave up" apart from "something actually broke" —
 * the former deserves neither an error dialog nor a "check the logs" hint.
 */
export class CancelledError extends Error {
    constructor() {
        super(t('Operation cancelled.'));
        this.name = 'CancelledError';
    }
}

/** Throw CancelledError when cancelled, otherwise do nothing. */
export function throwIfCancelled(isCancelled?: CancelCheck): void {
    if (isCancelled?.()) {
        throw new CancelledError();
    }
}

/** Whether a failure was caused by cancellation. */
export function isCancelled(err: unknown): boolean {
    return err instanceof CancelledError || (err as Error | undefined)?.name === 'CancelledError';
}
