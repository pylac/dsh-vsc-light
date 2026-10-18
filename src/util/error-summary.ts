/**
 * Compress an error into one line that fits in a dialog.
 *
 * Why this is needed:
 *   The Error thrown on a failed startup carries the entire captured stdout and stderr in its
 *   message (diagnostics meant for the log). Handing that to showErrorMessage pops a
 *   screen-filling, multi-line dialog where the user cannot find the point and cannot copy it
 *   either. So the dialog gets the first line and the full text goes to the log.
 */

import { t } from './l10n';

/** Upper bound for the single line shown in a dialog. */
export const DEFAULT_SUMMARY_LENGTH = 160;

/**
 * Take the first non-empty line and truncate it to the given length.
 *
 * Truncation appends an ellipsis so it is obvious there is more.
 */
export function summariseError(message: string, maxLength = DEFAULT_SUMMARY_LENGTH): string {
    const raw = String(message ?? '');
    const firstLine = raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line !== '') ?? t('Unknown error');

    if (firstLine.length <= maxLength) { return firstLine; }

    // Reserve one character for the ellipsis so the result cannot exceed the limit
    return `${firstLine.slice(0, Math.max(0, maxLength - 1))}…`;
}
