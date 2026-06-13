// Codex / OpenAI (ChatGPT) provider.
// Fetches usage data from the ChatGPT internal API.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {BaseProvider} from './base.js';

const API_BASE = 'https://chatgpt.com';
const USAGE_ENDPOINT = '/backend-api/wham/usage';
const REFERER = 'https://chatgpt.com/codex/settings/usage';
const WIN_PRIMARY = 'primary';
const WIN_WEEKLY = 'weekly';

export class CodexProvider extends BaseProvider {
    static get id() {
        return 'codex';
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

    static get brandColor() {
        return 'rgba(16, 163, 127, 0.40)';
    }

    static detectCredentials() {
        const found = [];
        const homeDir = GLib.get_home_dir();

        const defaultPath = GLib.build_filenamev([homeDir, '.codex', 'auth.json']);
        if (GLib.file_test(defaultPath, GLib.FileTest.EXISTS))
            found.push({name: 'Default', credentialPath: ''});

        const codexHome = GLib.getenv('CODEX_HOME');
        if (codexHome) {
            const envPath = GLib.build_filenamev([codexHome, 'auth.json']);
            if (GLib.file_test(envPath, GLib.FileTest.EXISTS) && envPath !== defaultPath)
                found.push({name: 'Custom', credentialPath: envPath});
        }

        return found;
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

    async fetchUsage(account, session, getToken) {
        // Keyring token (manual override) — use directly.
        const keyringToken = await getToken(account.id);
        if (keyringToken) {
            const normalized = keyringToken.trim().replace(/^Bearer\s+/i, '').trim();
            return this._callUsageApi(normalized, session);
        }

        // File-based token from the Codex CLI auth file.
        const credPath = this._resolveCredentialPath(account);
        const token = await this._readTokenFromFile(credPath);

        if (!token) {
            throw new Error(
                'No authentication token available. Install Codex CLI or set token manually in Settings.'
            );
        }

        const normalized = token.trim().replace(/^Bearer\s+/i, '').trim();

        // Do NOT refresh the token here. The Codex CLI owns auth.json and is the
        // only writer; refreshing from the extension would persist a rotated
        // refresh token and can invalidate the CLI's own login under token
        // rotation / reuse detection. If the token is expired, ask the user to
        // let the CLI refresh it.
        if (this._isTokenExpired(normalized)) {
            throw new Error('Codex token expired, please run codex to refresh');
        }

        try {
            return await this._callUsageApi(normalized, session);
        } catch (e) {
            if (e.statusCode === 401 || e.statusCode === 403) {
                throw new Error('Auth failed, please run codex to authenticate');
            }
            throw e;
        }
    }

    _callUsageApi(normalizedToken, session) {
        return new Promise((resolve, reject) => {
            const url = `${API_BASE}${USAGE_ENDPOINT}`;
            const message = Soup.Message.new('GET', url);
            const path = USAGE_ENDPOINT;

            message.request_headers.append('Accept', 'application/json');
            message.request_headers.append('Authorization', `Bearer ${normalizedToken}`);
            message.request_headers.append('Referer', REFERER);
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
                            reject(this._createHttpError(`Auth failed (HTTP ${statusCode}). Token may be expired.`, message));
                            return;
                        }

                        if (statusCode === 429) {
                            reject(this._createHttpError('Rate limited (HTTP 429)', message));
                            return;
                        }

                        if (statusCode !== 200) {
                            reject(this._createHttpError(`HTTP ${statusCode}`, message));
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
            WIN_PRIMARY,
            '5-Hour'
        );
        if (primary) windows.push({...primary, shortLabel: '5h'});

        // Attempt to extract secondary (weekly) window
        const weekly = this._extractWindow(
            rateLimit,
            ['secondary_window', 'secondary', 'weekly', 'seven_day', '7d'],
            WIN_WEEKLY,
            '7-Day'
        );
        if (weekly) windows.push({...weekly, shortLabel: '7d'});

        // If no structured windows found, try flat keys at top level
        if (windows.length === 0) {
            const flat = this._extractFlatWindow(rateLimit);
            if (flat) windows.push(flat);
        }

        // Try to extract plan name. Only dedicated plan keys are consulted:
        // a generic 'type' key matches unrelated fields (e.g. {type: 'TOKENS_LIMIT'})
        // and would surface a garbage tier string.
        const planName =
            this._findDeep(data, 'plan_type') ??
            this._findDeep(data, 'tier') ??
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
        const parsed = this._parseWindowObject(obj, WIN_PRIMARY, 'Usage');
        // Only return if we found meaningful data
        if (parsed.used !== null || parsed.limit !== null || parsed.utilization > 0) {
            // Structured windows carry an explicit shortLabel; the flat fallback
            // must supply one too, otherwise the panel renders a '??' placeholder.
            return {...parsed, shortLabel: 'RL'};
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
