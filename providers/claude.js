// Claude Code (Anthropic) provider.
// Fetches usage data from the Anthropic OAuth usage API.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {BaseProvider} from './base.js';
import {
    PROVIDER_CLAUDE,
    CLAUDE_API_URL,
    CLAUDE_BETA_HEADER,
    WINDOW_FIVE_HOUR,
    WINDOW_SEVEN_DAY,
} from '../constants.js';

export class ClaudeProvider extends BaseProvider {
    static get id() {
        return PROVIDER_CLAUDE;
    }

    static get displayName() {
        return 'Claude Code';
    }

    static get shortName() {
        return 'CC';
    }

    static get supportsAutoDetect() {
        return true;
    }

    static get requiresManualToken() {
        return false;
    }

    static getDefaultConfig() {
        return {
            credentialPath: '',  // empty = use default ~/.claude/.credentials.json
        };
    }

    static getConfigFields() {
        return [
            {
                key: 'credentialPath',
                label: 'Credentials file path (empty for default)',
                type: 'string',
                placeholder: '~/.claude/.credentials.json',
            },
        ];
    }

    /**
     * Resolve the credentials file path for this account.
     * Priority: account config > CLAUDE_CONFIG_DIR env > default.
     */
    _resolveCredentialPath(account) {
        const customPath = account.config?.credentialPath;
        if (customPath && customPath.trim() !== '') {
            // Expand ~/ to home directory (only current user's home)
            if (customPath === '~' || customPath.startsWith('~/')) {
                return GLib.get_home_dir() + customPath.substring(1);
            }
            return customPath;
        }

        // Check CLAUDE_CONFIG_DIR environment variable
        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR');
        if (configDir) {
            return GLib.build_filenamev([configDir, '.credentials.json']);
        }

        // Default path
        return GLib.build_filenamev([
            GLib.get_home_dir(), '.claude', '.credentials.json',
        ]);
    }

    /**
     * Read OAuth token from the Claude credentials file.
     */
    _readTokenFromFile(filePath) {
        return new Promise((resolve, reject) => {
            const file = Gio.File.new_for_path(filePath);
            file.load_contents_async(null, (f, result) => {
                try {
                    const [ok, contents] = f.load_contents_finish(result);
                    if (!ok) {
                        reject(new Error(`Failed to read ${filePath}`));
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const json = JSON.parse(decoder.decode(contents));
                    const token = json?.claudeAiOauth?.accessToken;

                    if (!token) {
                        reject(new Error('No OAuth token found in credentials file'));
                        return;
                    }

                    resolve(token);
                } catch (e) {
                    reject(new Error(`Failed to parse credentials: ${e.message}`));
                }
            });
        });
    }

    async fetchUsage(account, session, getToken) {
        // Try to get token: first from keyring (manual override), then from file
        let token = await getToken(account.id);

        if (!token) {
            const credPath = this._resolveCredentialPath(account);
            token = await this._readTokenFromFile(credPath);
        }

        if (!token) {
            throw new Error('No authentication token available');
        }

        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', CLAUDE_API_URL);
            message.request_headers.append('Authorization', `Bearer ${token}`);
            message.request_headers.append('anthropic-beta', CLAUDE_BETA_HEADER);

            session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (sess, result) => {
                    try {
                        const bytes = sess.send_and_read_finish(result);
                        const statusCode = message.get_status();

                        if (statusCode === 401 || statusCode === 403) {
                            reject(new Error(`Auth failed (HTTP ${statusCode})`));
                            return;
                        }

                        if (statusCode !== 200) {
                            reject(new Error(`HTTP ${statusCode}`));
                            return;
                        }

                        const decoder = new TextDecoder('utf-8');
                        const data = JSON.parse(decoder.decode(bytes.get_data()));
                        resolve(this._normalizeResponse(data));
                    } catch (e) {
                        reject(new Error(`Failed to fetch usage: ${e.message}`));
                    }
                }
            );
        });
    }

    /**
     * Normalize the Anthropic API response into our standard format.
     *
     * Expected response:
     * {
     *   five_hour: { utilization: 42.5, resets_at: "2026-04-11T18:00:00Z" },
     *   seven_day: { utilization: 15.2, resets_at: "2026-04-14T00:00:00Z" }
     * }
     */
    _normalizeResponse(data) {
        const windows = [];

        if (data.five_hour) {
            windows.push({
                id: WINDOW_FIVE_HOUR,
                label: '5-Hour',
                used: null,
                limit: null,
                utilization: (data.five_hour.utilization ?? 0) / 100,
                resetsAt: data.five_hour.resets_at
                    ? new Date(data.five_hour.resets_at)
                    : null,
            });
        }

        if (data.seven_day) {
            windows.push({
                id: WINDOW_SEVEN_DAY,
                label: '7-Day',
                used: null,
                limit: null,
                utilization: (data.seven_day.utilization ?? 0) / 100,
                resetsAt: data.seven_day.resets_at
                    ? new Date(data.seven_day.resets_at)
                    : null,
            });
        }

        return {
            windows,
            planName: null,
        };
    }
}
