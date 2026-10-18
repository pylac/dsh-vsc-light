/**
 * The "open links externally" bridge script injected into the DSH page.
 *
 * Why injection is required:
 *   1. The DSH frontend renders every http/https link with target="_blank".
 *   2. VS Code's webview iframe sandbox tokens are allow-scripts / allow-same-origin /
 *      allow-forms / allow-pointer-lock / allow-downloads — there is no allow-popups, so the
 *      browser rejects the new-window request outright and the click does nothing.
 *   3. The outer CSP's frame-src only allows the proxy origin, so the iframe cannot navigate to
 *      an external site either.
 *
 *   The DSH page is cross-origin with the webview document, so the outer document cannot see its
 *   clicks. The page therefore has to hand the URL out itself via postMessage.
 *
 * This module has two jobs, delivered by one injected script (a document is injected only once):
 *   1. Open links externally: this file owns injection and the handshake, "what may be opened" is
 *      decided by util/external-link.ts, and the script's scheme allowlist is generated from
 *      there, so the two cannot drift apart.
 *   2. Clipboard bridge: the browser rejects navigator.clipboard.writeText in this cross-origin
 *      iframe, so the page's own copy buttons fail silently; rejected writes are handed to the
 *      outer document, and the extension writes them with vscode.env.clipboard.
 */

import { OPENABLE_SCHEMES } from './external-link';

/** Injection marker: serves as both a selector and a dedup key so HTML is never injected twice. */
export const BRIDGE_MARKER = 'data-dsh-bridge';

/** Past this size we give up on injection and fall back to streaming passthrough. */
export const MAX_INJECT_BYTES = 4 * 1024 * 1024;

/**
 * The bridge script itself.
 *
 * __SCHEMES__ is the only placeholder, substituted by buildBridgeScript().
 *
 * Two implementation details:
 *   - A capture-phase document-level listener: DSH is a React app whose re-renders replace the
 *     DOM, so handlers bound to specific elements would be lost, ones bound to document are not.
 *   - composedPath is used to find the anchor: the target may sit inside a shadow root, where
 *     closest finds nothing.
 */
const BRIDGE_SOURCE = `(function () {
  if (window.__dshLinkBridge) { return; }
  window.__dshLinkBridge = true;
  var SCHEMES = __SCHEMES__;
  var APP_ORIGIN = location.origin;

  // Load handshake: the outer document uses this message to tell that the DSH page really came up.
  // If it never arrives the page never rendered (e.g. the proxy guard rejected it — a 403 text
  // page runs no scripts), and the outer layer shows a retryable error state instead of waiting
  // on a blank iframe.
  try { parent.postMessage({ type: 'dsh-ready' }, '*'); } catch (err) { /* ignored */ }

  // Clipboard bridge: clipboard-write defaults to self only, and this page is embedded in a
  // cross-origin iframe inside vscode-webview://, so native navigator.clipboard.writeText is
  // rejected. Use the native path when it works (no change needed here if VS Code allows it
  // later); only a rejection is forwarded. The promise still resolves, so the page reports
  // "copied"; the extension guarantees the actual write.
  (function installClipboardBridge() {
    var clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') { return; }
    var nativeWrite = clipboard.writeText.bind(clipboard);
    try {
      Object.defineProperty(clipboard, 'writeText', {
        configurable: true,
        writable: true,
        value: function (text) {
          var value = String(text);
          return nativeWrite(value).catch(function () {
            try { parent.postMessage({ type: 'dsh-copy', text: value }, '*'); } catch (err) { /* ignored */ }
          });
        }
      });
    } catch (err) { /* non-configurable environment: keep the native behaviour */ }
  })();

  function findAnchor(event) {
    var path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (path) {
      for (var i = 0; i < path.length; i++) {
        var node = path[i];
        if (node && node.tagName === 'A' && node.href) { return node; }
      }
      return null;
    }
    var target = event.target;
    return target && target.closest ? target.closest('a[href]') : null;
  }

  function onClick(event) {
    if (event.defaultPrevented) { return; }
    var anchor = findAnchor(event);
    if (!anchor) { return; }
    var url;
    try { url = new URL(anchor.href, location.href); } catch (err) { return; }
    if (SCHEMES.indexOf(url.protocol) === -1) { return; }
    if (url.origin === APP_ORIGIN) { return; }
    event.preventDefault();
    event.stopPropagation();
    parent.postMessage({ type: 'dsh-open-external', url: url.href }, '*');
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
})();`;

/**
 * Build the script body (without the <script> tag).
 *
 * Exported separately so it can actually be executed inside something like node:vm, instead of
 * merely checking that a string "contains some text".
 */
export function buildBridgeSource(): string {
    return BRIDGE_SOURCE.replace('__SCHEMES__', JSON.stringify(OPENABLE_SCHEMES));
}

/** Build the complete <script> tag. */
export function buildBridgeScript(): string {
    return `<script ${BRIDGE_MARKER}>${buildBridgeSource()}</script>`;
}

/**
 * Inject the bridge script into HTML.
 *
 * Inserted before </body> (case-insensitive); appended when there is no </body>. Returns the
 * input unchanged when already injected — this function must be idempotent.
 */
export function injectBridge(html: string): string {
    if (html.includes(BRIDGE_MARKER)) { return html; }

    const script = buildBridgeScript();
    const at = html.toLowerCase().lastIndexOf('</body>');
    if (at === -1) { return html + script; }

    return html.slice(0, at) + script + html.slice(at);
}

/**
 * Whether a request is a top-level document request — only documents are worth injecting into.
 *
 * Any one of three hints suffices, because different browsers and scenarios send different
 * headers:
 *   - sec-fetch-dest: document — the authoritative signal in modern browsers
 *   - accept contains text/html — typical of navigations; static assets never do
 *   - path is / or ends with .html — covers clients that send neither header
 *
 * Being lenient here is safe: the actual injection additionally requires a text/html content-type
 * and no compression.
 */
export function isDocumentRequest(headers: Record<string, unknown>, requestUrl: string): boolean {
    if (String(headers['sec-fetch-dest'] ?? '').toLowerCase() === 'document') { return true; }
    if (String(headers.accept ?? '').toLowerCase().includes('text/html')) { return true; }

    const path = String(requestUrl ?? '').split('?')[0];
    return path === '/' || path.toLowerCase().endsWith('.html');
}
