// Claude Code (Anthropic) provider.
// Fetches usage data from the Anthropic OAuth usage API.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {BaseProvider} from './base.js';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const TOKEN_ENDPOINT = 'https://api.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const WIN_FIVE_HOUR = 'five_hour';
const WIN_SEVEN_DAY = 'seven_day';

export class ClaudeProvider extends BaseProvider {
    static get id() {
        return 'claude';
    }

    static get displayName() {
        return 'Claude Code';
    }

    static getIconUrl(style) {
        return style === 'color'
            ? 'https://cdn.simpleicons.org/claude'
            : 'https://cdn.simpleicons.org/claude/ffffff';
    }

    static get supportsAutoDetect() {
        return true;
    }

    static get requiresManualToken() {
        return false;
    }

    static get brandColor() {
        return 'rgba(217, 119, 80, 0.40)';
    }

    static detectCredentials() {
        const found = [];
        const homeDir = GLib.get_home_dir();

        const defaultPath = GLib.build_filenamev([homeDir, '.claude', '.credentials.json']);
        if (GLib.file_test(defaultPath, GLib.FileTest.EXISTS))
            found.push({name: 'Default', credentialPath: ''});

        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR');
        if (configDir) {
            const envPath = GLib.build_filenamev([configDir, '.credentials.json']);
            if (GLib.file_test(envPath, GLib.FileTest.EXISTS) && envPath !== defaultPath)
                found.push({name: 'Custom', credentialPath: envPath});
        }

        return found;
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
            if (customPath === '~' || customPath.startsWith('~/')) {
                return GLib.get_home_dir() + customPath.substring(1);
            }
            return customPath;
        }

        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR');
        if (configDir) {
            return GLib.build_filenamev([configDir, '.credentials.json']);
        }

        return GLib.build_filenamev([
            GLib.get_home_dir(), '.claude', '.credentials.json',
        ]);
    }

    /**
     * Read the full OAuth credentials object from the credentials file.
     * Returns { accessToken, refreshToken, expiresAt } or throws.
     */
    _readCredentials(filePath) {
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
                    const oauth = json?.claudeAiOauth;

                    if (!oauth?.accessToken) {
                        reject(new Error('No OAuth token found in credentials file'));
                        return;
                    }

                    resolve({
                        accessToken: oauth.accessToken,
                        refreshToken: oauth.refreshToken ?? null,
                        expiresAt: oauth.expiresAt ?? null,
                        _raw: json,
                        _filePath: filePath,
                    });
                } catch (e) {
                    reject(new Error(`Failed to parse credentials: ${e.message}`));
                }
            });
        });
    }



    async fetchUsage(account, session, getToken) {
        // Try keyring first (manual override). Treat failures as "no keyring token".
        let token = null;
        try {
            token = await getToken(account.id);
        } catch (_e) {
            // secret-tool not available or failed — fall through to file-based token
        }

        let creds = null;
        if (!token) {
            const credPath = this._resolveCredentialPath(account);
            creds = await this._readCredentials(credPath);

            // If the token is expired, do NOT refresh it to avoid invalidating the CLI's token.
            if (this._isExpiryTimestampExpired(creds.expiresAt)) {
                throw new Error('Auth expired, please run claude code to refresh');
            } else {
                token = creds.accessToken;
            }
        }

        if (!token)
            throw new Error('No authentication token available');

        try {
            return await this._callUsageApi(token, session);
        } catch (e) {
            // Do not attempt to refresh token automatically.
            if (e.statusCode === 401 || e.statusCode === 403) {
                throw new Error('Auth failed, please run claude code to authenticate');
            }
            throw e;
        }
    }

    _callUsageApi(token, session) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', API_URL);
            message.request_headers.append('Authorization', `Bearer ${token}`);
            message.request_headers.append('anthropic-beta', BETA_HEADER);
            message.request_headers.append('anthropic-version', '2023-06-01');
            message.request_headers.append('User-Agent', 'claude-code/2.1.168');

            session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (sess, result) => {
                    try {
                        const bytes = sess.send_and_read_finish(result);
                        const statusCode = message.get_status();

                        if (statusCode === 401 || statusCode === 403) {
                            reject(this._createHttpError(`Auth failed (HTTP ${statusCode})`, message));
                            return;
                        }

                        if (statusCode === 429) {
                            reject(this._createHttpError('Rate limited (HTTP 429)', message));
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
                id: WIN_FIVE_HOUR,
                label: '5-Hour',
                shortLabel: '5h',
                used: null,
                limit: null,
                utilization: (data.five_hour.utilization ?? 0) / 100,
                resetsAt: this._parseResetTimestamp(data.five_hour.resets_at),
            });
        }

        if (data.seven_day) {
            windows.push({
                id: WIN_SEVEN_DAY,
                label: '7-Day',
                shortLabel: '7d',
                used: null,
                limit: null,
                utilization: (data.seven_day.utilization ?? 0) / 100,
                resetsAt: this._parseResetTimestamp(data.seven_day.resets_at),
            });
        }

        return {
            windows,
            planName: null,
        };
    }
}
