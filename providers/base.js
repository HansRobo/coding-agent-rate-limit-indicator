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
     * Short label for the top bar (e.g. 'CC', 'CX').
     * @returns {string}
     */
    static get shortName() {
        throw new Error('Provider must define static shortName');
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
     * @returns {Array<{key: string, label: string, type: string, placeholder: string}>}
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
