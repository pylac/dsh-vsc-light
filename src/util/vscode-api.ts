/**
 * Lazily obtain the vscode API.
 *
 * Why lazily instead of a top-level import:
 *   Outside the extension host the module does not exist at all, and a top-level import would make
 *   every util / service module that references it fail to load — including the proxy, auth, and
 *   port-waiting code that does not need vscode.
 *
 * Resolution is attempted once and the result — success or failure — is cached.
 */

export type VscodeApi = typeof import('vscode');

let cached: VscodeApi | undefined;
let resolved = false;

/** Get the vscode API, or undefined when not inside an extension host. */
export function getVscodeApi(): VscodeApi | undefined {
    if (!resolved) {
        resolved = true;
        try {
            cached = require('vscode') as VscodeApi;
        } catch {
            cached = undefined;
        }
    }
    return cached;
}
