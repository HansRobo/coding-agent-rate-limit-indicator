// Token storage using secret-tool CLI (works in GNOME Shell main process).
// Uses Gio.Subprocess to call secret-tool, avoiding direct libsecret dependency
// which is not reliably available in the GNOME Shell process.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const ATTRIBUTE_KEY = 'coding-agent-rate-limit-account-id';

/**
 * Retrieve a token for an account from the GNOME Keyring via secret-tool.
 * @param {string} accountId
 * @returns {Promise<string|null>}
 */
export function getToken(accountId) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                ['secret-tool', 'lookup', ATTRIBUTE_KEY, accountId],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (p, result) => {
                try {
                    const [ok, stdout, stderr] = p.communicate_utf8_finish(result);
                    if (ok && stdout && stdout.trim() !== '') {
                        resolve(stdout.trim());
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    console.error('Rate Limit Indicator: Token lookup failed:', e.message);
                    resolve(null);
                }
            });
        } catch (e) {
            console.error('Rate Limit Indicator: Failed to spawn secret-tool:', e.message);
            resolve(null);
        }
    });
}

/**
 * Store a token for an account in the GNOME Keyring via secret-tool.
 * Note: secret-tool store reads the secret from stdin.
 * @param {string} accountId
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export function storeToken(accountId, token) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                [
                    'secret-tool', 'store',
                    '--label', `Coding Agent Rate Limit: ${accountId}`,
                    ATTRIBUTE_KEY, accountId,
                ],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            // secret-tool store reads the secret value from stdin
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
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                ['secret-tool', 'clear', ATTRIBUTE_KEY, accountId],
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
