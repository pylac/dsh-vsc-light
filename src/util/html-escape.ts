/**
 * HTML text escaping.
 *
 * Why this is needed: copy injected into the page comes from language packs
 * (l10n/bundle.l10n.*.json), and language packs can be translated or replaced — a translation
 * containing `<` or `"` would break the panel's markup outright, or even inject a script.
 * Escaping costs almost nothing, so it is done even though neither of the current bundles contains
 * such characters.
 */

/** Escape into a string safe for HTML text nodes and double-quoted attribute values. */
export function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
