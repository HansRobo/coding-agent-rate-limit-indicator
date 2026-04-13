// Provider registry.
// Central place to register and look up provider implementations.
// New providers are added here.

import {ClaudeProvider} from './providers/claude.js';
import {CodexProvider} from './providers/codex.js';
import {GlmProvider} from './providers/glm.js';

// Map of provider ID -> provider class
const _providers = new Map();

/**
 * Register a provider class.
 * @param {typeof import('./providers/base.js').BaseProvider} providerClass
 */
export function registerProvider(providerClass) {
    _providers.set(providerClass.id, providerClass);
}

/**
 * Get a provider class by ID.
 * @param {string} providerId
 * @returns {typeof import('./providers/base.js').BaseProvider | undefined}
 */
export function getProvider(providerId) {
    return _providers.get(providerId);
}

/**
 * Get all registered providers.
 * @returns {Array<typeof import('./providers/base.js').BaseProvider>}
 */
export function getAllProviders() {
    return Array.from(_providers.values());
}

/**
 * Get provider metadata for UI display.
 * @returns {Array<{id: string, displayName: string, shortLabel: string, cssClass: string}>}
 */
export function getProviderList() {
    return getAllProviders().map(p => ({
        id: p.id,
        displayName: p.displayName,
        shortLabel: p.shortLabel,
        cssClass: p.cssClass,
        supportsAutoDetect: p.supportsAutoDetect,
        requiresManualToken: p.requiresManualToken,
        tokenFieldLabel: p.tokenFieldLabel,
        configFields: p.getConfigFields(),
        defaultConfig: p.getDefaultConfig(),
    }));
}

/**
 * Create a provider instance for fetching data.
 * @param {string} providerId
 * @returns {import('./providers/base.js').BaseProvider | null}
 */
export function createProviderInstance(providerId) {
    const ProviderClass = _providers.get(providerId);
    if (!ProviderClass) return null;
    return new ProviderClass();
}

// --- Register built-in providers ---
registerProvider(ClaudeProvider);
registerProvider(CodexProvider);
registerProvider(GlmProvider);
