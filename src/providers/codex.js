// Codex / OpenAI (ChatGPT) provider.
// Fetches usage data from the ChatGPT internal API.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {BaseProvider} from './base.js';
import {
    PROVIDER_CODEX,
    CODEX_API_BASE,
    CODEX_USAGE_ENDPOINT,
    CODEX_REFERER,
    CODEX_AUTH_TOKEN_ENDPOINT,
    WINDOW_PRIMARY,
    WINDOW_WEEKLY,
} from '../constants.js';

export class CodexProvider extends BaseProvider {
    static get id() {
        return PROVIDER_CODEX;
    }

    static get displayName() {
        return 'Codex';
    }

    static get shortLabel() {
        return 'CX';
    }

    static getIconUrl(_style) {
        // cdn.simpleicons.org does not carry the OpenAI icon; use jsDelivr instead.
        // Color injection for monochrome is handled by IconCache._injectSvgColor().
        return 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg';
    }

    static get supportsAutoDetect() {
        return true;
    }

    static get requiresManualToken() {
        return false;
    }

    static getDefaultConfig() {
        return {
            credentialPath: '',  // empty = use default ~/.codex/auth.json
        };
    }

    static getConfigFields() {
        return [
            {
                key: 'credentialPath',
                label: 'Credentials file path (empty for default)',
                type: 'string',
                placeholder: '~/.codex/auth.json',
            },
        ];
    }

    /**
     * Resolve the credentials file path for this account.
     * Priority: account config > CODEX_HOME env > default.
     */
    _resolveCredentialPath(account) {
        const customPath = account.config?.credentialPath;
        if (customPath && customPath.trim() !== '') {
            if (customPath === '~' || customPath.startsWith('~/')) {
                return GLib.get_home_dir() + customPath.substring(1);
            }
            return customPath;
        }

        const codexHome = GLib.getenv('CODEX_HOME');
        if (codexHome) {
            return GLib.build_filenamev([codexHome, 'auth.json']);
        }

        return GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'auth.json']);
    }

    /**
     * Read OAuth token from the Codex CLI auth file (~/.codex/auth.json).
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

                    // Prefer API key if explicitly set
                    const apiKey = json?.OPENAI_API_KEY;
                    if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
                        resolve(apiKey.trim());
                        return;
                    }

                    const token = json?.tokens?.access_token;
                    if (!token) {
                        reject(new Error('No access token found in Codex auth file'));
                        return;
                    }

                    resolve(token);
                } catch (e) {
                    reject(new Error(`Failed to parse Codex credentials: ${e.message}`));
                }
            });
        });
    }

    /**
     * Decode a JWT payload (base64url → JSON).
     * Returns null if the token is not a valid JWT.
     */
    _decodeJwtPayload(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            // base64url → base64 (standard)
            const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            // atob is available in GNOME Shell 45+ (GJS 1.74+)
            return JSON.parse(atob(b64));
        } catch (_e) {
            return null;
        }
    }

    /**
     * Decode a JWT and check if it is expired (or within bufferSec of expiry).
     */
    _isTokenExpired(token, bufferSec = 60) {
        const payload = this._decodeJwtPayload(token);
        if (!payload || typeof payload.exp !== 'number') return false;
        return Date.now() / 1000 >= payload.exp - bufferSec;
    }

    /**
     * Extract the client_id claim from a JWT payload.
     * Falls back to the known Codex CLI client ID if parsing fails.
     */
    _extractClientId(token) {
        const payload = this._decodeJwtPayload(token);
        return payload?.client_id ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
    }

    /**
     * Use the refresh_token in auth.json to obtain a new access_token, then
     * write the updated tokens back to the file.
     */
    _refreshAccessToken(filePath, session) {
        return new Promise((resolve, reject) => {
            const file = Gio.File.new_for_path(filePath);
            file.load_contents_async(null, (f, loadResult) => {
                try {
                    const [ok, contents] = f.load_contents_finish(loadResult);
                    if (!ok) {
                        reject(new Error(`Failed to read ${filePath} for refresh`));
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const json = JSON.parse(decoder.decode(contents));

                    const refreshToken = json?.tokens?.refresh_token;
                    if (!refreshToken) {
                        reject(new Error('No refresh_token found in Codex auth file'));
                        return;
                    }

                    const currentAccessToken = json?.tokens?.access_token ?? '';
                    const clientId = this._extractClientId(currentAccessToken);

                    const body = GLib.Bytes.new(
                        new TextEncoder().encode(
                            `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(clientId)}`
                        )
                    );

                    const msg = Soup.Message.new('POST', CODEX_AUTH_TOKEN_ENDPOINT);
                    msg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
                    msg.set_request_body_from_bytes('application/x-www-form-urlencoded', body);

                    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, sendResult) => {
                        try {
                            const bytes = sess.send_and_read_finish(sendResult);
                            const statusCode = msg.get_status();

                            if (statusCode !== 200) {
                                reject(new Error(`Token refresh failed (HTTP ${statusCode})`));
                                return;
                            }

                            const respText = new TextDecoder('utf-8').decode(bytes.get_data());
                            const resp = JSON.parse(respText);

                            if (!resp.access_token) {
                                reject(new Error('Token refresh response missing access_token'));
                                return;
                            }

                            // Write updated tokens back to auth.json
                            json.tokens.access_token = resp.access_token;
                            if (resp.refresh_token) json.tokens.refresh_token = resp.refresh_token;
                            if (resp.id_token) json.tokens.id_token = resp.id_token;
                            json.last_refresh = new Date().toISOString();

                            GLib.file_set_contents(filePath, JSON.stringify(json, null, 4));

                            resolve(resp.access_token);
                        } catch (e) {
                            reject(new Error(`Token refresh error: ${e.message}`));
                        }
                    });
                } catch (e) {
                    reject(new Error(`Failed to parse auth file for refresh: ${e.message}`));
                }
            });
        });
    }

    async fetchUsage(account, session, getToken) {
        // Keyring token (manual override) — use directly without refresh
        const keyringToken = await getToken(account.id);
        if (keyringToken) {
            const normalized = keyringToken.trim().replace(/^Bearer\s+/i, '').trim();
            return this._callUsageApi(normalized, session);
        }

        // File-based token — refresh if expired, then call API
        const credPath = this._resolveCredentialPath(account);
        let token = await this._readTokenFromFile(credPath);

        if (!token) {
            throw new Error(
                'No authentication token available. Install Codex CLI or set token manually in Settings.'
            );
        }

        let normalized = token.trim().replace(/^Bearer\s+/i, '').trim();

        if (this._isTokenExpired(normalized)) {
            normalized = await this._refreshAccessToken(credPath, session);
        }

        try {
            return await this._callUsageApi(normalized, session);
        } catch (e) {
            // On 401, try one refresh and retry
            if (e.message.includes('401') || e.message.includes('403')) {
                normalized = await this._refreshAccessToken(credPath, session);
                return this._callUsageApi(normalized, session);
            }
            throw e;
        }
    }

    _callUsageApi(normalizedToken, session) {
        return new Promise((resolve, reject) => {
            const url = `${CODEX_API_BASE}${CODEX_USAGE_ENDPOINT}`;
            const message = Soup.Message.new('GET', url);
            const path = CODEX_USAGE_ENDPOINT;

            message.request_headers.append('Accept', 'application/json');
            message.request_headers.append('Authorization', `Bearer ${normalizedToken}`);
            message.request_headers.append('Referer', CODEX_REFERER);
            message.request_headers.append('oai-language', 'en-US');
            message.request_headers.append('x-openai-target-path', path);
            message.request_headers.append('x-openai-target-route', path);

            session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (sess, result) => {
                    try {
                        const bytes = sess.send_and_read_finish(result);
                        const statusCode = message.get_status();

                        if (statusCode === 401 || statusCode === 403) {
                            reject(new Error(`Auth failed (HTTP ${statusCode}). Token may be expired.`));
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
     * Normalize the ChatGPT usage API response.
     *
     * The response structure varies, but commonly contains:
     * {
     *   rate_limit: {
     *     ...
     *     windows or nested objects with:
     *       total_tokens_used, total_tokens_limit, resets_at, used_percent, ...
     *   }
     * }
     *
     * This parser walks the response tree to find rate limit windows.
     */
    _normalizeResponse(data) {
        const windows = [];

        // Try to find rate_limit data from multiple possible response shapes
        const rateLimit = this._findDeep(data, 'rate_limit') ?? data;

        // Attempt to extract primary (5-hour) window
        const primary = this._extractWindow(
            rateLimit,
            ['primary_window', 'primary', 'five_hour', '5h'],
            WINDOW_PRIMARY,
            '5-Hour'
        );
        if (primary) windows.push(primary);

        // Attempt to extract secondary (weekly) window
        const weekly = this._extractWindow(
            rateLimit,
            ['secondary_window', 'secondary', 'weekly', 'seven_day', '7d'],
            WINDOW_WEEKLY,
            'Weekly'
        );
        if (weekly) windows.push(weekly);

        // If no structured windows found, try flat keys at top level
        if (windows.length === 0) {
            const flat = this._extractFlatWindow(rateLimit);
            if (flat) windows.push(flat);
        }

        // Try to extract plan name
        const planName =
            this._findDeep(data, 'plan_type') ??
            this._findDeep(data, 'tier') ??
            this._findDeep(data, 'type') ??
            null;

        return {
            windows,
            planName: typeof planName === 'string' ? planName : null,
        };
    }

    /**
     * Extract a usage window from an object, trying multiple key names.
     */
    _extractWindow(obj, candidateKeys, windowId, label) {
        if (!obj || typeof obj !== 'object') return null;

        let windowData = null;
        for (const key of candidateKeys) {
            if (obj[key] && typeof obj[key] === 'object') {
                windowData = obj[key];
                break;
            }
        }
        if (!windowData) return null;

        return this._parseWindowObject(windowData, windowId, label);
    }

    /**
     * Parse a window object with various possible key names for used/limit/percent/reset.
     */
    _parseWindowObject(obj, windowId, label) {
        const used = this._findFirstNumeric(obj, [
            'total_tokens_used', 'used_tokens', 'tokens_used', 'used',
        ]);
        const limit = this._findFirstNumeric(obj, [
            'total_tokens_limit', 'token_limit', 'limit', 'quota', 'max',
        ]);
        // 'used_percent', 'percent', 'percentage' are always 0-100 scale.
        // 'utilization' is 0-1 scale by convention.
        const percent100 = this._findFirstNumeric(obj, [
            'used_percent', 'percent', 'percentage',
        ]);
        const utilizationFraction = (typeof obj['utilization'] === 'number') ? obj['utilization'] : null;

        // Compute utilization
        let utilization = 0;
        if (utilizationFraction !== null) {
            utilization = utilizationFraction;
        } else if (percent100 !== null) {
            utilization = percent100 / 100;
        } else if (used !== null && limit !== null && limit > 0) {
            utilization = used / limit;
        }
        utilization = Math.max(0, Math.min(1, utilization));

        const resetValue =
            obj.resets_at ?? obj.reset_at ?? obj.resetAt ?? obj.reset ?? null;
        const resetsAt = this._parseResetTimestamp(resetValue);

        return {
            id: windowId,
            label,
            used,
            limit,
            utilization,
            resetsAt,
        };
    }

    /**
     * Try to parse a flat response as a single usage window.
     */
    _extractFlatWindow(obj) {
        if (!obj || typeof obj !== 'object') return null;
        const parsed = this._parseWindowObject(obj, WINDOW_PRIMARY, 'Usage');
        // Only return if we found meaningful data
        if (parsed.used !== null || parsed.limit !== null || parsed.utilization > 0) {
            return parsed;
        }
        return null;
    }

    /**
     * Find the first numeric value in obj matching one of the candidate keys.
     */
    _findFirstNumeric(obj, keys) {
        for (const key of keys) {
            if (key in obj && typeof obj[key] === 'number') {
                return obj[key];
            }
        }
        return null;
    }

    /**
     * Recursively search for a key in a nested object/array.
     */
    _findDeep(obj, targetKey) {
        if (!obj || typeof obj !== 'object') return null;
        if (targetKey in obj) return obj[targetKey];

        const values = Array.isArray(obj) ? obj : Object.values(obj);
        for (const val of values) {
            const found = this._findDeep(val, targetKey);
            if (found !== null && found !== undefined) return found;
        }
        return null;
    }
}
