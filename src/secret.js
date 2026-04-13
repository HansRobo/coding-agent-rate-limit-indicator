// Token storage using secret-tool CLI (works in GNOME Shell main process).
// Uses Gio.Subprocess to call secret-tool, avoiding direct libsecret dependency
// which is not reliably available in the GNOME Shell process.
//
// Requires: libsecret-tools
//   Install: sudo apt install libsecret-tools

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const ATTRIBUTE_KEY = 'coding-agent-rate-limit-account-id';
const INSTALL_HINT = 'secret-tool not found. Install it with: sudo apt install libsecret-tools';
const SECRET_TOOL_PATH = GLib.find_program_in_path('secret-tool');

/**
 * Retrieve a token for an account from the GNOME Keyring via secret-tool.
 * Throws if secret-tool is not installed.
 * @param {string} accountId
 * @returns {Promise<string|null>}
 */
export function getToken(accountId) {
    if (!SECRET_TOOL_PATH)
        return Promise.reject(new Error(INSTALL_HINT));

    return new Promise((resolve, reject) => {
        try {
            const proc = Gio.Subprocess.new(
                [SECRET_TOOL_PATH, 'lookup', ATTRIBUTE_KEY, accountId],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (p, result) => {
                try {
                    const [ok, stdout] = p.communicate_utf8_finish(result);
                    if (ok && stdout && stdout.trim() !== '')
                        resolve(stdout.trim());
                    else
                        resolve(null);
                } catch (e) {
                    console.error('Rate Limit Indicator: Token lookup failed:', e.message);
                    reject(e);
                }
            });
        } catch (e) {
            console.error('Rate Limit Indicator: Failed to spawn secret-tool:', e.message);
            reject(e);
        }
    });
}

/**
 * Store a token for an account in the GNOME Keyring via secret-tool.
 * Logs a warning if secret-tool is not installed.
 * @param {string} accountId
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export function storeToken(accountId, token) {
    if (!SECRET_TOOL_PATH) {
        console.warn(`Rate Limit Indicator: ${INSTALL_HINT}`);
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                [
                    SECRET_TOOL_PATH, 'store',
                    '--label', `Coding Agent Rate Limit: ${accountId}`,
                    ATTRIBUTE_KEY, accountId,
                ],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(token, null, (p, result) => {
                try {
                    const [ok] = p.communicate_utf8_finish(result);
                    resolve(ok && p.get_successful());
                } catch (e) {
                    console.error('Rate Limit Indicator: Token store failed:', e.message);
                    resolve(false);
                }
            });
        } catch (e) {
            console.error('Rate Limit Indicator: Failed to spawn secret-tool:', e.message);
            resolve(false);
        }
    });
}

/**
 * Remove a token for an account from the GNOME Keyring via secret-tool.
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
export function clearToken(accountId) {
    if (!SECRET_TOOL_PATH) {
        console.warn(`Rate Limit Indicator: ${INSTALL_HINT}`);
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                [SECRET_TOOL_PATH, 'clear', ATTRIBUTE_KEY, accountId],
                Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.wait_async(null, (p, result) => {
                try {
                    p.wait_finish(result);
                    resolve(p.get_successful());
                } catch (e) {
                    resolve(false);
                }
            });
        } catch (e) {
            console.error('Rate Limit Indicator: Failed to spawn secret-tool:', e.message);
            resolve(false);
        }
    });
}
