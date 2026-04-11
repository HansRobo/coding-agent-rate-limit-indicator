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
    CLAUDE_TOKEN_ENDPOINT,
    CLAUDE_CLIENT_ID,
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

    /**
     * Check if the token is expired or within bufferSec of expiry.
     * expiresAt is epoch milliseconds (as stored by the Claude CLI).
     */
    _isTokenExpired(expiresAt, bufferSec = 300) {
        if (!expiresAt) return false;
        return Date.now() >= expiresAt - bufferSec * 1000;
    }

    /**
     * Use the refresh_token to obtain a new access_token, then write
     * the updated credentials back to the file.
     */
    _refreshAccessToken(creds, session) {
        return new Promise((resolve, reject) => {
            if (!creds.refreshToken) {
                reject(new Error('No refresh_token in Claude credentials file'));
                return;
            }

            const body = GLib.Bytes.new(
                new TextEncoder().encode(
                    `grant_type=refresh_token` +
                    `&refresh_token=${encodeURIComponent(creds.refreshToken)}` +
                    `&client_id=${encodeURIComponent(CLAUDE_CLIENT_ID)}`
                )
            );

            const msg = Soup.Message.new('POST', CLAUDE_TOKEN_ENDPOINT);
            msg.request_headers.append(
                'Content-Type', 'application/x-www-form-urlencoded'
            );
            msg.set_request_body_from_bytes('application/x-www-form-urlencoded', body);

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    const statusCode = msg.get_status();

                    const text = new TextDecoder('utf-8').decode(bytes.get_data());

                    if (statusCode !== 200) {
                        reject(new Error(`Token refresh failed (HTTP ${statusCode}): ${text}`));
                        return;
                    }

                    const resp = JSON.parse(text);

                    if (!resp.access_token) {
                        reject(new Error('Token refresh response missing access_token'));
                        return;
                    }

                    const raw = creds._raw;
                    raw.claudeAiOauth.accessToken = resp.access_token;
                    if (resp.refresh_token)
                        raw.claudeAiOauth.refreshToken = resp.refresh_token;
                    if (resp.expires_in)
                        raw.claudeAiOauth.expiresAt = Date.now() + resp.expires_in * 1000;

                    GLib.file_set_contents(
                        creds._filePath,
                        JSON.stringify(raw, null, 2)
                    );

                    resolve(resp.access_token);
                } catch (e) {
                    reject(new Error(`Token refresh error: ${e.message}`));
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

            // Proactively refresh if the token is expired or about to expire
            if (this._isTokenExpired(creds.expiresAt)) {
                token = await this._refreshAccessToken(creds, session);
            } else {
                token = creds.accessToken;
            }
        }

        if (!token)
            throw new Error('No authentication token available');

        try {
            return await this._callUsageApi(token, session);
        } catch (e) {
            // On auth failure, try refreshing the token once and retry
            if ((e.statusCode === 401 || e.statusCode === 403) && creds) {
                const newToken = await this._refreshAccessToken(creds, session);
                return this._callUsageApi(newToken, session);
            }
            throw e;
        }
    }

    _callUsageApi(token, session) {
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
                            const err = new Error(`Auth failed (HTTP ${statusCode})`);
                            err.statusCode = statusCode;
                            reject(err);
                            return;
                        }

                        if (statusCode === 429) {
                            const err = new Error('Rate limited (HTTP 429)');
                            err.statusCode = 429;
                            const retryAfter = message.response_headers.get_one('Retry-After');
                            if (retryAfter) {
                                const secs = parseInt(retryAfter, 10);
                                if (!isNaN(secs) && secs > 0)
                                    err.retryAfter = secs;
                            }
                            reject(err);
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
                resetsAt: this._parseResetTimestamp(data.five_hour.resets_at),
            });
        }

        if (data.seven_day) {
            windows.push({
                id: WINDOW_SEVEN_DAY,
                label: '7-Day',
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
