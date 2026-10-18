/**
 * Build the code-reference text pasted into a DSH conversation.
 *
 * The syntax is a convention between this extension and the agent, not a grammar DSH parses:
 * DSH only treats `@path` as a file mention (see FILE_REFERENCE_PROMPT in dsh-file-reference),
 * and the line suffix after the colon is ordinary text the agent reads before opening the file
 * with its read tool. That is why both a single line and a range work: the extension asks DSH
 * for no new syntax.
 *
 * Why this lives in its own module:
 *   Line numbers are one-based for humans while vscode.Selection is zero-based — the conversion
 *   belongs in one place, or `@a.ts:42` will eventually point at line 41. It is pure and
 *   vscode-free, so it can be asserted without an extension host.
 */

/**
 * Build the reference text: `@file:12` for one line, `@file:12-20` for a range.
 *
 * Arguments are **zero-based** (matching vscode.Selection); the output is one-based.
 *
 * When the start is after the end (should not happen) the two are swapped, never emitting an
 * inverted range.
 *
 * @param filePath File path (this extension passes an absolute path; see the note in panel.ts).
 * @param startLine Selection start line (zero-based).
 * @param endLine Selection end line (zero-based, inclusive).
 * @returns Reference text such as `@D:\src\a.ts:42` or `@"C:\my dir\a.ts":42-51`.
 */
export function formatReference(filePath: string, startLine: number, endLine: number): string {
    const first = Math.max(0, Math.min(startLine, endLine)) + 1;
    const last = Math.max(0, Math.max(startLine, endLine)) + 1;
    const path = quotePath(filePath);
    return last > first ? `@${path}:${first}-${last}` : `@${path}:${first}`;
}

/**
 * Quote a path containing spaces the way the DSH mention grammar requires.
 *
 * Unquoted, `@my file.ts:12` splits into two words and the agent has to guess which part is the
 * path. `@"..."` is what DSH itself documents (see FILE_REFERENCE_PROMPT).
 *
 * A path containing a double quote is left unquoted: the grammar cannot represent it safely, and
 * showing the real characters beats emitting a broken mention.
 */
function quotePath(path: string): string {
    // Quotes only, no repeated @ — formatReference adds the prefix.
    return /\s/.test(path) && !path.includes('"') ? `"${path}"` : path;
}

/**
 * Convert a selection's end line into the last line that is really selected (zero-based).
 *
 * Why: when whole lines are dragged out, VSCode puts the selection end at column 0 of the
 * following line, which selects no character of that line. Without the correction we would emit
 * `@a.ts:10-11` where line 11 is empty and the agent makes a pointless read.
 *
 * A single-line selection (end.line equals start.line) is untouched: character is then an in-line
 * offset, not "the start of the next line".
 *
 * @param startLine Selection start line (zero-based).
 * @param endLine Selection end line (zero-based).
 * @param endCharacter Selection end column offset.
 * @returns The corrected end line (zero-based, inclusive).
 */
export function lastSelectedLine(startLine: number, endLine: number, endCharacter: number): number {
    if (endCharacter === 0 && endLine > startLine) { return endLine - 1; }
    return endLine;
}
