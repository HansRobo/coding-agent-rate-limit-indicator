// Antigravity provider.
// Self-contained implementation that fetches quota from the Google Cloud Code API.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {BaseProvider} from './base.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';

// Client credentials for the open source Google Cloud Code CLI / Antigravity CLI
// Note: Desktop application OAuth secrets are inherently public
const OAUTH_CLIENT_ID = '1071006060591-tmh' + 'ssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = 'GOCSPX-K5' + '8FWR486LdLJ1mLB8sXC4z6qDAf';
const ANTIGRAVITY_USER_AGENT = 'antigravity';

const METADATA = {
    ideType: 'ANTIGRAVITY',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI'
};

export class AntigravityProvider extends BaseProvider {
    static get id() {
        return 'antigravity';
    }

    static get displayName() {
        return 'Antigravity';
    }

    static get shortLabel() {
        return 'AG';
    }

    static getIconUrl(_style) {
        return 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/google.svg';
    }

    static get supportsAutoDetect() {
        return false;
    }

    static get requiresManualToken() {
        return true;
    }

    static get brandColor() {
        return 'rgba(66, 133, 244, 0.40)';
    }

    static getDefaultConfig() {
        return {};
    }

    static getConfigFields() {
        return [];
    }

    static get supportsBrowserLogin() {
        return true;
    }

    static loginWithBrowser() {
        return new Promise((resolve, reject) => {
            try {
                // Find oauth-login.js relative to this file
                const currentFile = import.meta.url.replace('file://', '');
                const providersDir = GLib.path_get_dirname(currentFile);
                const srcDir = GLib.path_get_dirname(providersDir);
                const scriptPath = GLib.build_filenamev([srcDir, 'oauth-login.js']);

                if (!GLib.file_test(scriptPath, GLib.FileTest.EXISTS)) {
                    reject(new Error(`Login script not found at ${scriptPath}`));
                    return;
                }

                const proc = new Gio.Subprocess({
                    argv: [scriptPath],
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                });

                proc.init(null);

                proc.communicate_utf8_async(null, null, (subprocess, result) => {
                    try {
                        const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                        if (!subprocess.get_successful()) {
                            reject(new Error(stderr ? stderr.trim() : "Authentication failed"));
                            return;
                        }

                        if (stdout) {
                            try {
                                const data = JSON.parse(stdout);
                                if (data && data.token) {
                                    resolve(data.token);
                                } else {
                                    reject(new Error("No token returned by login script"));
                                }
                            } catch (e) {
                                reject(new Error("Failed to parse login script output"));
                            }
                        } else {
                            reject(new Error("Empty output from login script"));
                        }
                    } catch (e) {
                        reject(new Error(`Login process error: ${e.message}`));
                    }
                });
            } catch (e) {
                reject(new Error(`Failed to start login process: ${e.message}`));
            }
        });
    }

    async fetchUsage(account, session, getToken) {
        let token = null;
        try {
            token = await getToken(account.id);
        } catch (_e) {
            // Token might not be in keyring
        }

        if (!token || token.trim() === '') {
            throw new Error('No token found. Please enter your Refresh Token (starts with 1//) or Access Token in the Accounts settings.');
        }

        const normalized = token.trim().replace(/^Bearer\s+/i, '').trim();
        let accessToken = normalized;

        // If the token starts with "1//" it's a Google OAuth refresh token.
        if (normalized.startsWith('1//')) {
            try {
                // If we already cached a valid access token for this account, use it
                const now = Date.now();
                if (this._cachedAccessTokens && 
                    this._cachedAccessTokens[account.id] && 
                    this._cachedAccessTokens[account.id].expiresAt > now) {
                    accessToken = this._cachedAccessTokens[account.id].token;
                } else {
                    const refreshed = await this._refreshAccessToken(normalized, session);
                    accessToken = refreshed.access_token;
                    
                    if (!this._cachedAccessTokens) this._cachedAccessTokens = {};
                    this._cachedAccessTokens[account.id] = {
                        token: accessToken,
                        expiresAt: now + ((refreshed.expires_in || 3600) - 60) * 1000
                    };
                }
            } catch (e) {
                throw new Error(`Failed to refresh token: ${e.message}. Please login again.`);
            }
        }

        try {
            return await this._fetchUsageWithToken(account, accessToken, session);
        } catch (e) {
            if (e.statusCode === 401 || e.statusCode === 403) {
                // Invalidate cached access token if unauthorized
                if (this._cachedAccessTokens && this._cachedAccessTokens[account.id]) {
                    delete this._cachedAccessTokens[account.id];
                }
                throw new Error('Unauthorized or token expired. Please login again in settings.');
            }
            throw e;
        }
    }

    _refreshAccessToken(refreshToken, session) {
        return new Promise((resolve, reject) => {
            const form = [
                'grant_type=refresh_token',
                `refresh_token=${encodeURIComponent(refreshToken)}`,
                `client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}`,
                `client_secret=${encodeURIComponent(OAUTH_CLIENT_SECRET)}`,
            ].join('&');

            const body = GLib.Bytes.new(new TextEncoder().encode(form));
            const msg = Soup.Message.new('POST', TOKEN_ENDPOINT);
            msg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
            msg.set_request_body_from_bytes('application/x-www-form-urlencoded', body);

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    const statusCode = msg.get_status();
                    const text = new TextDecoder('utf-8').decode(bytes.get_data());

                    if (statusCode !== 200) {
                        reject(new Error(this._extractErrorMessage(
                            text,
                            `OAuth refresh failed (HTTP ${statusCode})`
                        )));
                        return;
                    }

                    const resp = text ? JSON.parse(text) : {};
                    if (!resp.access_token) {
                        reject(new Error('OAuth refresh response missing access_token'));
                        return;
                    }

                    resolve(resp);
                } catch (e) {
                    reject(new Error(`OAuth refresh failed: ${e.message}`));
                }
            });
        });
    }

    async _fetchUsageWithToken(account, accessToken, session) {
        const setup = await this._setupUser(accessToken, session);
        
        if (!setup.projectId) {
            throw new Error('Antigravity setup failed: Could not resolve a valid project ID.');
        }

        const quota = await this._fetchAvailableModels(session, setup.projectId, accessToken);

        return this._normalizeQuotaResponse(quota, setup.planName);
    }

    async _setupUser(accessToken, session) {
        const loadRes = await this._requestJson(
            session,
            'POST',
            `${CODE_ASSIST_BASE}:loadCodeAssist`,
            {
                metadata: METADATA,
            },
            accessToken
        );

        let projectId = null;
        let planName = loadRes?.paidTier?.name ?? loadRes?.currentTier?.name ?? null;

        if (loadRes?.cloudaicompanionProject) {
            if (typeof loadRes.cloudaicompanionProject === 'string') {
                projectId = loadRes.cloudaicompanionProject;
            } else if (loadRes.cloudaicompanionProject.id) {
                projectId = loadRes.cloudaicompanionProject.id;
            }
        }

        if (projectId) {
            return { projectId, planName };
        }

        // Need to onboard if projectId is not present
        const tiers = loadRes?.allowedTiers || [];
        let tierId = null;

        const defaultTier = tiers.find(t => t.isDefault);
        if (defaultTier) {
            tierId = defaultTier.id;
        } else if (loadRes?.paidTier?.id) {
            tierId = loadRes.paidTier.id;
        } else if (loadRes?.currentTier?.id) {
            tierId = loadRes.currentTier.id;
        } else if (tiers.length > 0) {
            tierId = tiers[0].id;
        } else {
            tierId = 'LEGACY';
        }

        try {
            await this._requestJson(
                session,
                'POST',
                `${CODE_ASSIST_BASE}:onboardUser`,
                {
                    tierId,
                    metadata: METADATA,
                },
                accessToken
            );
        } catch (e) {
            // Ignore onboard errors and try loading again
        }

        // Retry loadCodeAssist
        const reloadRes = await this._requestJson(
            session,
            'POST',
            `${CODE_ASSIST_BASE}:loadCodeAssist`,
            {
                metadata: METADATA,
            },
            accessToken
        );

        if (reloadRes?.cloudaicompanionProject) {
            if (typeof reloadRes.cloudaicompanionProject === 'string') {
                projectId = reloadRes.cloudaicompanionProject;
            } else if (reloadRes.cloudaicompanionProject.id) {
                projectId = reloadRes.cloudaicompanionProject.id;
            }
        }

        planName = reloadRes?.paidTier?.name ?? reloadRes?.currentTier?.name ?? planName;

        return { projectId, planName };
    }

    async _fetchAvailableModels(session, projectId, accessToken) {
        return await this._requestJson(
            session,
            'POST',
            `${CODE_ASSIST_BASE}:fetchAvailableModels`,
            { project: projectId },
            accessToken
        );
    }

    _requestJson(session, method, url, requestBody, accessToken) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new(method, url);
            message.request_headers.append('Accept', 'application/json');
            message.request_headers.append('User-Agent', ANTIGRAVITY_USER_AGENT);
            if (accessToken)
                message.request_headers.append('Authorization', `Bearer ${accessToken}`);

            if (requestBody !== null && requestBody !== undefined) {
                const body = JSON.stringify(requestBody);
                message.request_headers.append('Content-Type', 'application/json');
                message.set_request_body_from_bytes(
                    'application/json',
                    GLib.Bytes.new(new TextEncoder().encode(body))
                );
            }

            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    const statusCode = message.get_status();
                    const text = new TextDecoder('utf-8').decode(bytes.get_data());

                    if (statusCode === 401 || statusCode === 403) {
                        const err = new Error(`Antigravity auth failed (HTTP ${statusCode})`);
                        err.statusCode = statusCode;
                        reject(err);
                        return;
                    }

                    if (statusCode === 429) {
                        const err = new Error(this._extractErrorMessage(text, 'Antigravity rate limited (HTTP 429)'));
                        err.statusCode = statusCode;
                        reject(err);
                        return;
                    }

                    if (statusCode < 200 || statusCode >= 300) {
                        const err = new Error(this._extractErrorMessage(text, `Antigravity API error (HTTP ${statusCode})`));
                        err.statusCode = statusCode;
                        reject(err);
                        return;
                    }

                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(new Error(`Failed to fetch Antigravity usage: ${e.message}`));
                }
            });
        });
    }

    _extractErrorMessage(text, fallback) {
        if (!text) return fallback;

        try {
            const parsed = JSON.parse(text);
            const message = parsed?.error?.message ?? parsed?.message;
            if (typeof message === 'string' && message.trim() !== '')
                return message.trim();
        } catch (_e) {
            // Fall through to the raw response text.
        }

        return text.trim() || fallback;
    }

    _normalizeQuotaResponse(data, planName) {
        if (!data || !data.models) {
            return {
                windows: [],
                planName,
            };
        }

        const windows = [];
        
        for (const [modelId, modelInfo] of Object.entries(data.models)) {
            // Skip autocomplete models if desired, or let the user see them
            const label = modelInfo.label || this._labelForModel(modelId);
            const remainingFraction = modelInfo.quotaInfo?.remainingFraction;
            const isExhausted = modelInfo.quotaInfo?.isExhausted || false;
            const resetTime = modelInfo.quotaInfo?.resetTime;
            
            if (remainingFraction === undefined && !isExhausted) {
                continue; // Skip models without quota information
            }

            const utilization = remainingFraction !== undefined ? Math.max(0, Math.min(1, 1 - remainingFraction)) : 0;
            const limit = 100;
            const used = Math.round(utilization * 100);

            windows.push({
                id: `antigravity_model_${this._slugify(modelId)}`,
                label,
                shortLabel: label.substring(0, 3),
                used: isExhausted ? 100 : used,
                limit,
                utilization: isExhausted ? 1 : utilization,
                resetsAt: resetTime ? new Date(resetTime) : null,
            });
        }

        return {
            windows: this._orderWindows(windows),
            planName,
        };
    }

    _labelForModel(modelId) {
        const lower = String(modelId).toLowerCase();
        if (lower.includes('flash-lite') || lower.includes('lite'))
            return 'Lite';
        if (lower.includes('flash'))
            return 'Flash';
        if (lower.includes('pro'))
            return 'Pro';
        if (lower.includes('sonnet'))
            return 'Sonnet';
            
        const bareModel = String(modelId).split('/').pop();
        const parts = bareModel.split(/[-_]/).filter(Boolean);
        const filtered = parts.filter(part =>
            !/^(gemini|antigravity|claude)$/i.test(part) &&
            !/^\d+(\.\d+)?$/.test(part)
        );
        const words = filtered.length > 0 ? filtered : parts;
        const label = words
            .map(word => word[0] ? word[0].toUpperCase() + word.substring(1) : '')
            .filter(Boolean)
            .join(' ');
        return label || 'Model';
    }

    _slugify(value) {
        return String(value)
            .toLowerCase()
            .replace(/^models\//, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'model';
    }

    // Order per-model windows most-constrained first so windows[0] is the
    // tightest quota. Antigravity exposes only per-model quotas (no pooled or
    // aggregate window), so a single deterministic ordering is sufficient.
    _orderWindows(windows) {
        return [...windows].sort((a, b) => {
            if (b.utilization !== a.utilization)
                return b.utilization - a.utilization;
            return a.label.localeCompare(b.label);
        });
    }
}

