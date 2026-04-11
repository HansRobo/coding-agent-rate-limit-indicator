// Multi-account management.
// Accounts are stored as a JSON array in GSettings.
// Each account: { id, provider, name, config }.

import GLib from 'gi://GLib';

/**
 * Generate a unique account ID.
 * Uses a combination of timestamp and random hex.
 */
export function generateAccountId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 8);
    return `${ts}-${rand}`;
}

/**
 * Read the accounts array from GSettings.
 * @param {Gio.Settings} settings
 * @returns {Array<Object>}
 */
export function loadAccounts(settings) {
    try {
        const json = settings.get_string('accounts-json');
        const accounts = JSON.parse(json);
        return Array.isArray(accounts) ? accounts : [];
    } catch (e) {
        console.error('Rate Limit Indicator: Failed to parse accounts:', e.message);
        return [];
    }
}

/**
 * Write the accounts array to GSettings.
 * @param {Gio.Settings} settings
 * @param {Array<Object>} accounts
 */
export function saveAccounts(settings, accounts) {
    settings.set_string('accounts-json', JSON.stringify(accounts));
}

/**
 * Get visible account IDs from GSettings.
 * @param {Gio.Settings} settings
 * @returns {string[]}
 */
export function loadVisibleIds(settings) {
    return settings.get_strv('visible-account-ids');
}

/**
 * Set visible account IDs.
 * @param {Gio.Settings} settings
 * @param {string[]} ids
 */
export function saveVisibleIds(settings, ids) {
    settings.set_strv('visible-account-ids', ids);
}

/**
 * Get only the accounts marked as visible.
 * If no visibility filter is set, all accounts are visible.
 * @param {Gio.Settings} settings
 * @returns {Array<Object>}
 */
export function getVisibleAccounts(settings) {
    const accounts = loadAccounts(settings);
    const visibleIds = loadVisibleIds(settings);

    if (visibleIds.length === 0) {
        return accounts;
    }

    const idSet = new Set(visibleIds);
    return accounts.filter(a => idSet.has(a.id));
}

/**
 * Add a new account.
 * @param {Gio.Settings} settings
 * @param {string} provider - Provider ID
 * @param {string} name     - Display name
 * @param {Object} config   - Provider-specific config
 * @returns {Object} The created account object
 */
export function addAccount(settings, provider, name, config = {}) {
    const accounts = loadAccounts(settings);
    const account = {
        id: generateAccountId(),
        provider,
        name,
        config,
    };
    accounts.push(account);
    saveAccounts(settings, accounts);

    // Auto-add to visible list
    const visibleIds = loadVisibleIds(settings);
    visibleIds.push(account.id);
    saveVisibleIds(settings, visibleIds);

    return account;
}

/**
 * Update an existing account.
 * @param {Gio.Settings} settings
 * @param {string} accountId
 * @param {Object} updates - Partial account fields to merge
 * @returns {Object|null} Updated account or null if not found
 */
export function updateAccount(settings, accountId, updates) {
    const accounts = loadAccounts(settings);
    const idx = accounts.findIndex(a => a.id === accountId);
    if (idx === -1) return null;

    const account = accounts[idx];
    if (updates.name !== undefined) account.name = updates.name;
    if (updates.config !== undefined) {
        account.config = {...account.config, ...updates.config};
    }

    saveAccounts(settings, accounts);
    return account;
}

/**
 * Remove an account by ID.
 * @param {Gio.Settings} settings
 * @param {string} accountId
 */
export function removeAccount(settings, accountId) {
    const accounts = loadAccounts(settings).filter(a => a.id !== accountId);
    saveAccounts(settings, accounts);

    // Also remove from visible list
    const visibleIds = loadVisibleIds(settings).filter(id => id !== accountId);
    saveVisibleIds(settings, visibleIds);
}

/**
 * Toggle account visibility.
 * @param {Gio.Settings} settings
 * @param {string} accountId
 * @param {boolean} visible
 */
export function setAccountVisibility(settings, accountId, visible) {
    let visibleIds = loadVisibleIds(settings);
    const isCurrentlyVisible = visibleIds.includes(accountId);

    if (visible && !isCurrentlyVisible) {
        visibleIds.push(accountId);
    } else if (!visible && isCurrentlyVisible) {
        visibleIds = visibleIds.filter(id => id !== accountId);
    }

    saveVisibleIds(settings, visibleIds);
}

/**
 * Get display label for an account, including provider short name
 * if there are multiple accounts.
 * @param {Object} account
 * @param {Array<Object>} allVisibleAccounts
 * @param {Object} providerRegistry - Registry to look up provider short names
 * @returns {string}
 */
export function getAccountDisplayLabel(account, allVisibleAccounts, providerRegistry) {
    const provider = providerRegistry.get(account.provider);
    const shortName = provider ? provider.shortName : account.provider.toUpperCase();

    // Check if there are multiple accounts for this provider
    const sameProviderAccounts = allVisibleAccounts.filter(
        a => a.provider === account.provider
    );

    if (sameProviderAccounts.length > 1) {
        // Show provider + account name initials
        const name = account.name?.trim() || '??';
        const initials = name
            .split(/\s+/)
            .filter(w => w.length > 0)
            .map(w => w[0])
            .join('')
            .toUpperCase()
            .substring(0, 2) || '??';
        return `${shortName}(${initials})`;
    }

    return shortName;
}

/**
 * Auto-detect Codex CLI auth files on disk.
 * Checks default and CODEX_HOME locations.
 * @returns {Array<{name: string, credentialPath: string}>}
 */
export function detectCodexCredentials() {
    const found = [];
    const homeDir = GLib.get_home_dir();

    const defaultPath = GLib.build_filenamev([homeDir, '.codex', 'auth.json']);
    if (GLib.file_test(defaultPath, GLib.FileTest.EXISTS)) {
        found.push({name: 'Default', credentialPath: ''});
    }

    const codexHome = GLib.getenv('CODEX_HOME');
    if (codexHome) {
        const envPath = GLib.build_filenamev([codexHome, 'auth.json']);
        if (
            GLib.file_test(envPath, GLib.FileTest.EXISTS) &&
            envPath !== defaultPath
        ) {
            found.push({name: 'Custom', credentialPath: envPath});
        }
    }

    return found;
}

/**
 * Auto-detect Claude accounts from credential files on disk.
 * Checks default and common locations.
 * @returns {Array<{name: string, credentialPath: string}>}
 */
export function detectClaudeCredentials() {
    const found = [];
    const homeDir = GLib.get_home_dir();

    // Check default path
    const defaultPath = GLib.build_filenamev([homeDir, '.claude', '.credentials.json']);
    if (GLib.file_test(defaultPath, GLib.FileTest.EXISTS)) {
        found.push({name: 'Default', credentialPath: ''});
    }

    // Check CLAUDE_CONFIG_DIR
    const configDir = GLib.getenv('CLAUDE_CONFIG_DIR');
    if (configDir) {
        const envPath = GLib.build_filenamev([configDir, '.credentials.json']);
        if (
            GLib.file_test(envPath, GLib.FileTest.EXISTS) &&
            envPath !== defaultPath
        ) {
            found.push({name: 'Custom', credentialPath: envPath});
        }
    }

    return found;
}
