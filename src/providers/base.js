// Base provider interface.
// All concrete providers must extend this class and implement fetchUsage().

/**
 * Normalized usage window returned by providers.
 * @typedef {Object} UsageWindow
 * @property {string}  id           - Window identifier (e.g. 'five_hour', 'seven_day')
 * @property {string}  label        - Human-readable label (e.g. '5-Hour', '7-Day')
 * @property {number|null} used     - Tokens/requests used (null if unavailable)
 * @property {number|null} limit    - Token/request limit (null if unavailable)
 * @property {number}  utilization  - 0-1 fraction of usage
 * @property {Date|null}   resetsAt - When this window resets (null if unavailable)
 */

/**
 * Normalized result from a provider fetch.
 * @typedef {Object} UsageResult
 * @property {UsageWindow[]} windows  - Rate limit windows, ordered primary-first
 * @property {string|null}   planName - Subscription plan name if available
 */

export class BaseProvider {
    /**
     * Unique provider identifier (e.g. 'claude', 'codex').
     * @returns {string}
     */
    static get id() {
        throw new Error('Provider must define static id');
    }

    /**
     * Human-readable name (e.g. 'Claude Code', 'Codex').
     * @returns {string}
     */
    static get displayName() {
        throw new Error('Provider must define static displayName');
    }

    /**
     * Short text fallback label for the top bar when icon is unavailable (e.g. 'CC', 'CX').
     * Default derives 2 uppercase initials from displayName words.
     * Override in subclasses for a custom fallback.
     * @returns {string}
     */
    static get shortLabel() {
        return this.displayName
            .split(/\s+/)
            .filter(w => w.length > 0)
            .map(w => w[0])
            .join('')
            .toUpperCase()
            .substring(0, 2) || '??';
    }

    /**
     * Return the URL to fetch this provider's icon SVG.
     * @param {string} style - 'monochrome' or 'color'
     * @returns {string} URL
     */
    static getIconUrl(_style) {
        throw new Error(`Provider ${this.id} must implement static getIconUrl(style)`);
    }

    /**
     * CSS class suffix for provider-specific styling.
     * @returns {string}
     */
    static get cssClass() {
        return this.id;
    }

    /**
     * Default configuration for a new account of this provider type.
     * Override in subclasses to supply provider-specific defaults.
     * @returns {Object}
     */
    static getDefaultConfig() {
        return {};
    }

    /**
     * Description of what config fields this provider expects.
     * Used by the preferences UI to render provider-specific settings.
     * Supported field types:
     *   - string: free-form text input
     *   - choice: select from a fixed list of options
     * @returns {Array<{
     *   key: string,
     *   label: string,
     *   type: string,
     *   placeholder?: string,
     *   options?: Array<{value: string, label: string}>
     * }>}
     */
    static getConfigFields() {
        return [];
    }

    /**
     * Whether this provider supports auto-detecting credentials from disk.
     * @returns {boolean}
     */
    static get supportsAutoDetect() {
        return false;
    }

    /**
     * Whether this provider requires a manually-entered token.
     * @returns {boolean}
     */
    static get requiresManualToken() {
        return true;
    }

    /**
     * Label for the token input field in the settings UI.
     * Override in subclasses to match the provider's own terminology.
     * @returns {string}
     */
    static get tokenFieldLabel() {
        return 'Bearer token';
    }

    /**
     * Create a decorated Error from an HTTP response.
     * Sets statusCode on the error; for 429 also parses the Retry-After header.
     * @param {string} message - Error message text
     * @param {Soup.Message} soupMessage - The Soup.Message that produced the response
     * @returns {Error}
     */
    _createHttpError(message, soupMessage) {
        const err = new Error(message);
        err.statusCode = soupMessage.get_status();
        if (err.statusCode === 429) {
            const retryAfter = soupMessage.response_headers.get_one('Retry-After');
            if (retryAfter) {
                const secs = parseInt(retryAfter, 10);
                if (!isNaN(secs) && secs > 0)
                    err.retryAfter = secs;
            }
        }
        return err;
    }

    /**
     * Parse a reset timestamp that may be an ISO string, Unix seconds, or Unix milliseconds.
     * Returns a Date or null.
     */
    _parseResetTimestamp(value) {
        if (value == null) return null;

        if (typeof value === 'string') {
            // Pure-digit string: treat as a numeric timestamp.
            if (/^\d+$/.test(value)) {
                const n = Number.parseInt(value, 10);
                const ms = n < 1e12 ? n * 1000 : n;
                const d = new Date(ms);
                return isNaN(d.getTime()) ? null : d;
            }

            const d = new Date(value);
            return isNaN(d.getTime()) ? null : d;
        }

        if (typeof value === 'number') {
            // Values below 1e12 are likely Unix seconds (not milliseconds).
            // Current time in seconds is ~1.77e9, in milliseconds ~1.77e12.
            const ms = value < 1e12 ? value * 1000 : value;
            const d = new Date(ms);
            return isNaN(d.getTime()) ? null : d;
        }

        return null;
    }

    /**
     * Check if an epoch-ms expiry timestamp is expired or within bufferSec of expiry.
     * Returns false when expiresAt is falsy (treat unknown expiry as still valid).
     */
    _isExpiryTimestampExpired(expiresAt, bufferSec = 300) {
        if (!expiresAt) return false;
        return Date.now() >= expiresAt - bufferSec * 1000;
    }

    /**
     * Fetch usage data for the given account.
     *
     * @param {Object} account        - Account object {id, provider, name, config}
     * @param {Soup.Session} session   - Shared HTTP session
     * @param {Function} getToken      - async (accountId) => string|null, retrieves stored token
     * @returns {Promise<UsageResult>} - Normalized usage data
     * @throws {Error} on auth failure or network error
     */
    async fetchUsage(_account, _session, _getToken) {
        throw new Error('Provider must implement fetchUsage()');
    }
}
