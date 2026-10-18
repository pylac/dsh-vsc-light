import * as crypto from 'crypto';
import { escapeHtml } from './util/html-escape';
import { t } from './util/l10n';
import { getVscodeApi } from './util/vscode-api';

/**
 * The document language for the panel page.
 *
 * The overlay copy comes from t(), which follows the display language, so `<html lang>` must follow
 * the same source. Screen readers and font selection read it, and a hardcoded value mislabels the
 * page whenever the other language is active.
 */
function documentLanguage(): string {
    const language = getVscodeApi()?.env?.language ?? 'en';
    return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * Build the panel HTML: a full-bleed iframe plus a retryable error overlay.
 *
 * Three things happen here, all of them necessary (plus one more relay channel for the clipboard;
 * see point 4):
 *
 * 1. The iframe points at the proxy's entry URL, carrying the one-time session secret that is
 *    traded for the session cookie.
 *
 * 2. A small script relays **link requests** out of the iframe to the extension. The iframe loads
 *    the DSH page (http://127.0.0.1:PORT), cross-origin with this document, so this document can
 *    neither see its clicks nor influence its new-window requests; and DSH puts target="_blank" on
 *    every http/https link while VS Code's webview sandbox has no allow-popups — the new-window
 *    request is rejected outright and the click does nothing.
 *
 * 3. **Load handshake and error layer**: the bridge script injected into the DSH page announces
 *    dsh-ready when it loads; if it never arrives the page never rendered (the service is gone, or
 *    the proxy guard rejected it — a 403 text page runs no scripts), so a retryable error state is
 *    shown instead of leaving the user staring at a blank iframe.
 *
 * 4. **Clipboard relay**: the page is a cross-origin iframe, so the browser rejects
 *    navigator.clipboard writes to the system clipboard; the injected script therefore hands
 *    rejected writes out via postMessage, which is relayed to the extension and written with
 *    vscode.env.clipboard.writeText. The iframe's allow="clipboard-write" only gives the native
 *    path a chance; the bridge is the guarantee.
 *
 * @param entryUrl The proxy entry URL carrying the one-time session secret (see proxy.getEntryUrl()).
 */
export function getWebviewContent(entryUrl: string): string {
    // The message-origin check compares origins, which are path-independent, so the origin is
    // derived from the entry URL.
    const origin = new URL(entryUrl).origin;

    // The nonce in the CSP must match the one on the <script> tag below.
    const nonce = crypto.randomBytes(16).toString('hex');

    // Copy is injected in two different contexts and must be escaped accordingly:
    //   - HTML text nodes and attributes: escapeHtml()
    //   - JS string literals inside <script>: JSON.stringify(), which handles quotes, backslashes
    //     and newlines
    const overlayTitle = escapeHtml(t('DSH is temporarily unavailable'));
    const retryLabel = escapeHtml(t('Retry'));
    const showLogsLabel = escapeHtml(t('Show Logs'));

    const readyTimeoutMessage = JSON.stringify(t(
        'The DSH page did not load. The service may have exited, or the request was rejected by the proxy.'
    ));
    const restartingMessage = JSON.stringify(t('Restarting DSH...'));
    const fallbackMessage = JSON.stringify(t('DSH is temporarily unavailable.'));

    return `<!DOCTYPE html>
<html lang="${documentLanguage()}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
            frame-src ${origin};
            script-src 'nonce-${nonce}';
            style-src 'unsafe-inline';">
    <title>DSH</title>
    <style>
        html, body { margin: 0; padding: 0; height: 100vh; overflow: hidden; background: var(--vscode-editor-background, #1e1e1e); }
        iframe { width: 100%; height: 100%; border: none; display: block; }

        #overlay {
            position: fixed; inset: 0; display: flex;
            align-items: center; justify-content: center;
            background: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-foreground, #ccc);
            font-family: var(--vscode-font-family, sans-serif);
            padding: 24px; box-sizing: border-box;
        }
        /* The hidden attribute has to be honoured explicitly: the display:flex above overrides its default */
        #overlay[hidden] { display: none; }

        .card { max-width: 420px; text-align: center; }
        .title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
        .text { font-size: 13px; line-height: 1.6; opacity: 0.85; margin-bottom: 20px; }
        button {
            font-family: inherit; font-size: 13px; cursor: pointer;
            padding: 4px 14px; margin: 0 4px; border-radius: 2px;
            color: var(--vscode-button-foreground, #fff);
            background: var(--vscode-button-background, #0e639c);
            border: none;
        }
        button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
        button.secondary {
            color: var(--vscode-button-secondaryForeground, #ccc);
            background: var(--vscode-button-secondaryBackground, #3a3d41);
        }
    </style>
</head>
<body>
    <iframe id="dsh-frame" src="${entryUrl}" allow="clipboard-write; clipboard-read"></iframe>
    <div id="overlay" hidden>
        <div class="card">
            <div class="title">${overlayTitle}</div>
            <div class="text" id="overlay-text"></div>
            <div>
                <button id="btn-retry">${retryLabel}</button>
                <button id="btn-logs" class="secondary">${showLogsLabel}</button>
            </div>
        </div>
    </div>
    <script nonce="${nonce}">
        (function () {
            var vscode = acquireVsCodeApi();
            var PROXY_ORIGIN = ${JSON.stringify(origin)};

            // When the page loads fine, dsh-ready arrives during parsing, before the iframe's load
            // event, so the state has to be remembered or arming on load would misreport a healthy
            // page.
            var ready = false;
            var readyTimer = null;

            var frame = document.getElementById('dsh-frame');
            var overlay = document.getElementById('overlay');
            var overlayText = document.getElementById('overlay-text');

            function clearTimer() {
                if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
            }

            function showOverlay(text) {
                clearTimer();
                overlayText.textContent = text;
                overlay.hidden = false;
            }

            function hideOverlay() {
                clearTimer();
                overlay.hidden = true;
            }

            function armReadyTimeout() {
                clearTimer();
                if (ready) { return; }
                readyTimer = setTimeout(function () {
                    showOverlay(${readyTimeoutMessage});
                }, 15000);
            }

            frame.addEventListener('load', armReadyTimeout);
            armReadyTimeout();

            window.addEventListener('message', function (event) {
                var data = event.data;
                if (!data || typeof data.type !== 'string') { return; }

                // Messages from the iframe: it must be that frame, and the origin must be the proxy
                // origin. event.source is used rather than origin alone so these can be told apart
                // from extension instructions.
                if (event.source === frame.contentWindow) {
                    if (event.origin !== PROXY_ORIGIN) { return; }

                    if (data.type === 'dsh-ready') {
                        ready = true;
                        hideOverlay();
                        return;
                    }

                    if (data.type === 'dsh-open-external' && typeof data.url === 'string') {
                        vscode.postMessage({ type: 'openExternal', url: data.url });
                    }

                    // Relay from the page's clipboard bridge (see util/html-bridge.ts). The cap
                    // matches MAX_COPY_TEXT_LENGTH on the extension side; both sides clamp.
                    if (data.type === 'dsh-copy' && typeof data.text === 'string' &&
                        data.text.length > 0 && data.text.length <= 2097152) {
                        vscode.postMessage({ type: 'copyText', text: data.text });
                    }
                    return;
                }

                // Anything else is only accepted as an allowlisted extension instruction
                if (data.type === 'showError') {
                    showOverlay(typeof data.message === 'string' && data.message !== ''
                        ? data.message
                        : ${fallbackMessage});
                }
            });

            document.getElementById('btn-retry').addEventListener('click', function () {
                showOverlay(${restartingMessage});
                // Retry is delegated to the extension's restart command: it rebuilds the service
                // and the port changes, so merely reloading the iframe would not do.
                vscode.postMessage({ type: 'retry' });
            });

            document.getElementById('btn-logs').addEventListener('click', function () {
                vscode.postMessage({ type: 'showLogs' });
            });
        })();
    </script>
</body>
</html>`;
}
