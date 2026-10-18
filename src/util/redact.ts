/**
 * Mask the DSH startup credential in text meant for humans.
 *
 * What is masked:
 *   On startup DSH prints `dsh web: http://127.0.0.1:PORT/?token=<random>` to stdout, and that
 *   token is the only credential that can be exchanged for the auth cookie — the extension trades
 *   it, and whoever holds it can act as an authenticated DSH client while the process lives.
 *
 * Why it has to be masked:
 *   The extension copies DSH's stdout into the VS Code output channel and, on a failed startup,
 *   into "Copy Error Details". Those are exactly what users paste into bug reports — unmasked, the
 *   credential for a local service that can run tools becomes public with it.
 *
 * Why only the value is masked and the URL is kept:
 *   The port, path, and timing are what diagnose startup problems, while the token itself is
 *   useless for that.
 *
 * Note: use this only on log and display copies. Parsing (parseToken in util/cli.ts) must see the
 * raw text, otherwise the extension could not exchange it for a cookie itself.
 */

/**
 * Match `token=` and its value, keeping the separator and the parameter name.
 *
 * The leading separator covers URL query strings (`?` / `&`), command lines (spaces), and log
 * quoting (single and double quotes), so `?token=x`, `&token=x`, and a leading `token=x` all
 * match.
 *
 * Case-insensitive: DSH prints lowercase today, but there is no reason for casing to change
 * safety.
 */
const TOKEN_PATTERN = /([?&;\s"'`]|^)(token=)([^\s&"'<>]+)/gi;

/**
 * Replace every token value in the text with `***`.
 *
 * Idempotent: masking an already masked text changes nothing (`***` is matched and written back
 * as `***`).
 *
 * @param text Text that may contain the credential (a log line, an error message, a stdout dump).
 * @returns The same text with token values masked.
 */
export function redactToken(text: string): string {
    return String(text).replace(TOKEN_PATTERN, (_match, separator: string, key: string) => `${separator}${key}***`);
}
