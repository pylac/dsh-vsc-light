/**
 * Runtime message translation.
 *
 * Usage: source code carries the **English source string**, Chinese lives in
 * l10n/bundle.l10n.zh-cn.json, and this function swaps it according to VS Code's current display
 * language.
 *
 *   t('DSH service stopped.')            → translate the whole message
 *   t('Copied: {0}', reference)          → with placeholders
 *
 * Why a wrapper instead of vscode.l10n.t directly:
 *   the util layer deliberately avoids a vscode dependency, so it can be loaded and called outside
 *   an extension host. This layer uses the same lazy resolution internally and returns the English
 *   source unchanged when the API is unavailable.
 */
import { getVscodeApi } from './vscode-api';

/**
 * Substitute positional placeholders such as {0} and {1}.
 *
 * Why the fallback path has to substitute too:
 *   A context without the vscode API (tests, outside the extension host) would otherwise return
 *   the raw text, and the caller would see a message containing a literal `{0}`. A placeholder
 *   with no matching argument is left as-is rather than eaten, so no information is lost.
 */
function format(message: string, args: Array<string | number | boolean>): string {
    return message.replace(/\{(\d+)\}/g, (whole, index: string) => {
        const position = Number(index);
        return position < args.length ? String(args[position]) : whole;
    });
}

export function t(message: string, ...args: Array<string | number | boolean>): string {
    const api = getVscodeApi();
    if (!api) { return format(message, args); }

    return api.l10n.t(message, ...args);
}
