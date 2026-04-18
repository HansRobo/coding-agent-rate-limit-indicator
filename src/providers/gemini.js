// Gemini / Antigravity provider.
// Fetches quota from the Google Code Assist API used by Gemini CLI.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {BaseProvider} from './base.js';
import {
    PROVIDER_GEMINI,
    GEMINI_TOKEN_ENDPOINT,
    GEMINI_CODE_ASSIST_BASE,
    WINDOW_PRIMARY,
} from '../constants.js';

const PANEL_QUOTA_MOST_CONSTRAINED = 'most_constrained';
const PANEL_QUOTA_POOLED_FIRST = 'pooled_first';
const PANEL_QUOTA_POOLED_ONLY = 'pooled_only';

const USER_TIER_FREE = 'free-tier';
const USER_TIER_LEGACY = 'legacy-tier';
const GEMINI_USER_AGENT = 'coding-agent-rate-limit-indicator/1.0.0';

export class GeminiProvider extends BaseProvider {
    static get id() {
        return PROVIDER_GEMINI;
    }

    static get displayName() {
        return 'Gemini';
    }

    static get shortLabel() {
        return 'GM';
    }

    static getIconUrl(_style) {
        return 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlegemini.svg';
    }

    static get supportsAutoDetect() {
        return true;
    }

    static get requiresManualToken() {
        return false;
    }

    static getDefaultConfig() {
        return {
            credentialPath: '',
            projectId: '',
            panelQuotaStrategy: PANEL_QUOTA_MOST_CONSTRAINED,
        };
    }

    static getConfigFields() {
        return [
            {
                key: 'credentialPath',
                label: 'Credentials file path (empty for default)',
                type: 'string',
                placeholder: '~/.gemini/oauth_creds.json',
            },
            {
                key: 'projectId',
                label: 'Google Cloud project ID (optional)',
                type: 'string',
                placeholder: 'my-gcp-project',
            },
            {
                key: 'panelQuotaStrategy',
                label: 'Panel quota strategy',
                type: 'choice',
                options: [
                    {value: PANEL_QUOTA_MOST_CONSTRAINED, label: 'Most constrained'},
                    {value: PANEL_QUOTA_POOLED_FIRST, label: 'Pooled first'},
                    {value: PANEL_QUOTA_POOLED_ONLY, label: 'Pooled only'},
                ],
            },
        ];
    }

    _resolveCredentialPath(account) {
        const customPath = account.config?.credentialPath;
        if (customPath && customPath.trim() !== '') {
            if (customPath === '~' || customPath.startsWith('~/'))
                return GLib.get_home_dir() + customPath.substring(1);
            return customPath;
        }

        return GLib.build_filenamev([GLib.get_home_dir(), '.gemini', 'oauth_creds.json']);
    }

    _resolveConfiguredProjectId(account) {
        const configured = account.config?.projectId?.trim();
        if (configured)
            return configured;

        const envProject =
            GLib.getenv('GOOGLE_CLOUD_PROJECT') ??
            GLib.getenv('GOOGLE_CLOUD_PROJECT_ID') ??
            '';
        return envProject.trim() || null;
    }

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

                    if (!json?.access_token) {
                        reject(new Error('No access token found in Gemini credentials file'));
                        return;
                    }

                    resolve({
                        accessToken: json.access_token,
                        refreshToken: json.refresh_token ?? null,
                        expiresAt: this._parseResetTimestamp(json.expiry_date)?.getTime() ?? null,
                        _raw: json,
                        _filePath: filePath,
                    });
                } catch (e) {
                    reject(new Error(`Failed to parse Gemini credentials: ${e.message}`));
                }
            });
        });
    }

    _loadGeminiCliOAuthCreds() {
        if (this._geminiCliCreds)
            return this._geminiCliCreds;

        const binPath = GLib.find_program_in_path('gemini');
        if (!binPath)
            throw new Error('Gemini CLI not found. Install it with: npm install -g @google/gemini-cli');

        const binFile = Gio.File.new_for_path(binPath);
        const symlinkInfo = binFile.query_info(
            'standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
        let bundleDir;
        if (symlinkInfo.get_is_symlink()) {
            let target = symlinkInfo.get_symlink_target();
            if (!target.startsWith('/'))
                target = GLib.build_filenamev([GLib.path_get_dirname(binPath), target]);
            bundleDir = GLib.path_get_dirname(target);
        } else {
            bundleDir = GLib.path_get_dirname(binPath);
        }

        const dir = Gio.File.new_for_path(bundleDir);
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        const idRegex = /OAUTH_CLIENT_ID\s*=\s*"([^"]+)"/;
        const secretRegex = /OAUTH_CLIENT_SECRET\s*=\s*"([^"]+)"/;
        let clientId = null;
        let clientSecret = null;
        let fileInfo;
        while ((fileInfo = enumerator.next_file(null)) !== null && (!clientId || !clientSecret)) {
            const name = fileInfo.get_name();
            if (!name.endsWith('.js'))
                continue;
            const filePath = GLib.build_filenamev([bundleDir, name]);
            const [ok, contents] = GLib.file_get_contents(filePath);
            if (!ok)
                continue;
            const text = new TextDecoder('utf-8').decode(contents);
            if (!clientId) {
                const match = idRegex.exec(text);
                if (match)
                    clientId = match[1];
            }
            if (!clientSecret) {
                const match = secretRegex.exec(text);
                if (match)
                    clientSecret = match[1];
            }
        }
        enumerator.close(null);

        if (!clientId || !clientSecret)
            throw new Error(
                'Could not find Gemini OAuth credentials in @google/gemini-cli bundle. ' +
                'Try updating it: npm install -g @google/gemini-cli'
            );

        this._geminiCliCreds = {clientId, clientSecret};
        return this._geminiCliCreds;
    }

    _refreshAccessToken(creds, session) {
        return new Promise((resolve, reject) => {
            if (!creds.refreshToken) {
                reject(new Error('No refresh_token found in Gemini credentials file'));
                return;
            }

            let oauthCreds;
            try {
                oauthCreds = this._loadGeminiCliOAuthCreds();
            } catch (e) {
                reject(e);
                return;
            }

            const form = [
                'grant_type=refresh_token',
                `refresh_token=${encodeURIComponent(creds.refreshToken)}`,
                `client_id=${encodeURIComponent(oauthCreds.clientId)}`,
                `client_secret=${encodeURIComponent(oauthCreds.clientSecret)}`,
            ].join('&');

            const body = GLib.Bytes.new(new TextEncoder().encode(form));
            const msg = Soup.Message.new('POST', GEMINI_TOKEN_ENDPOINT);
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
                            `Gemini token refresh failed (HTTP ${statusCode})`
                        )));
                        return;
                    }

                    const resp = text ? JSON.parse(text) : {};
                    if (!resp.access_token) {
                        reject(new Error('Gemini token refresh response missing access_token'));
                        return;
                    }

                    creds._raw.access_token = resp.access_token;
                    if (resp.refresh_token)
                        creds._raw.refresh_token = resp.refresh_token;
                    if (resp.id_token)
                        creds._raw.id_token = resp.id_token;
                    if (resp.scope)
                        creds._raw.scope = resp.scope;
                    if (resp.token_type)
                        creds._raw.token_type = resp.token_type;
                    if (resp.expires_in)
                        creds._raw.expiry_date = Date.now() + resp.expires_in * 1000;

                    GLib.file_set_contents(
                        creds._filePath,
                        JSON.stringify(creds._raw, null, 2)
                    );

                    resolve(resp.access_token);
                } catch (e) {
                    reject(new Error(`Gemini token refresh failed: ${e.message}`));
                }
            });
        });
    }

    async fetchUsage(account, session, getToken) {
        let token = null;
        try {
            token = await getToken(account.id);
        } catch (_e) {
            // Fall back to file-based auth when secret-tool is unavailable.
        }

        let creds = null;
        if (!token) {
            const credPath = this._resolveCredentialPath(account);
            creds = await this._readCredentials(credPath);

            if (this._isExpiryTimestampExpired(creds.expiresAt)) {
                token = await this._refreshAccessToken(creds, session);
            } else {
                token = creds.accessToken;
            }
        }

        if (!token) {
            throw new Error(
                'No authentication token available. Install Gemini CLI or set a token override in Settings.'
            );
        }

        const normalized = token.trim().replace(/^Bearer\s+/i, '').trim();

        try {
            return await this._fetchUsageWithToken(account, normalized, session);
        } catch (e) {
            if ((e.statusCode === 401 || e.statusCode === 403) && creds) {
                const refreshed = await this._refreshAccessToken(creds, session);
                return this._fetchUsageWithToken(account, refreshed, session);
            }
            throw e;
        }
    }

    async _fetchUsageWithToken(account, accessToken, session) {
        const setup = await this._setupUser(account, accessToken, session);
        const quota = await this._retrieveUserQuota(session, setup.projectId, accessToken);

        return this._normalizeQuotaResponse(quota, setup.planName, account);
    }

    async _retrieveUserQuota(session, projectId, accessToken) {
        const url = `${GEMINI_CODE_ASSIST_BASE}:retrieveUserQuota`;

        try {
            return await this._requestJson(
                session,
                'POST',
                url,
                {
                    project: projectId,
                    userAgent: GEMINI_USER_AGENT,
                },
                accessToken
            );
        } catch (e) {
            if (e?.message?.includes('Unknown name "userAgent"')) {
                return this._requestJson(
                    session,
                    'POST',
                    url,
                    {project: projectId},
                    accessToken
                );
            }
            throw e;
        }
    }

    async _setupUser(account, accessToken, session) {
        const configuredProjectId = this._resolveConfiguredProjectId(account);
        const loadRes = await this._requestJson(
            session,
            'POST',
            `${GEMINI_CODE_ASSIST_BASE}:loadCodeAssist`,
            {
                cloudaicompanionProject: configuredProjectId ?? undefined,
                metadata: this._buildClientMetadata(configuredProjectId),
            },
            accessToken
        );

        this._validateLoadCodeAssistResponse(loadRes);

        if (loadRes.currentTier) {
            if (!loadRes.cloudaicompanionProject) {
                if (configuredProjectId) {
                    return {
                        projectId: configuredProjectId,
                        planName: loadRes.paidTier?.name ?? loadRes.currentTier.name ?? null,
                    };
                }

                this._throwIneligibleOrProjectRequired(loadRes);
            }

            return {
                projectId: loadRes.cloudaicompanionProject,
                planName: loadRes.paidTier?.name ?? loadRes.currentTier.name ?? null,
            };
        }

        const tier = this._getOnboardTier(loadRes);
        const onboardReq = tier.id === USER_TIER_FREE
            ? {
                tierId: tier.id,
                cloudaicompanionProject: undefined,
                metadata: this._buildClientMetadata(null),
            }
            : {
                tierId: tier.id,
                cloudaicompanionProject: configuredProjectId ?? undefined,
                metadata: this._buildClientMetadata(configuredProjectId),
            };

        let operation = await this._requestJson(
            session,
            'POST',
            `${GEMINI_CODE_ASSIST_BASE}:onboardUser`,
            onboardReq,
            accessToken
        );

        while (!operation.done && operation.name) {
            await this._delayMs(5000);
            operation = await this._requestJson(
                session,
                'GET',
                `${GEMINI_CODE_ASSIST_BASE}/${operation.name}`,
                null,
                accessToken
            );
        }

        const onboardProjectId =
            operation?.response?.cloudaicompanionProject?.id ??
            configuredProjectId;

        if (!onboardProjectId) {
            this._throwIneligibleOrProjectRequired(loadRes);
        }

        return {
            projectId: onboardProjectId,
            planName: tier.name ?? null,
        };
    }

    _buildClientMetadata(projectId) {
        const metadata = {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
        };

        if (projectId)
            metadata.duetProject = projectId;

        return metadata;
    }

    _validateLoadCodeAssistResponse(loadRes) {
        if (!loadRes)
            throw new Error('Gemini setup returned an empty response');

        if (!loadRes.currentTier && Array.isArray(loadRes.ineligibleTiers)) {
            const validationTier = loadRes.ineligibleTiers.find(tier =>
                tier?.validationUrl &&
                tier?.reasonCode === 'VALIDATION_REQUIRED'
            );

            if (validationTier) {
                const description = validationTier.reasonMessage ?? 'Account validation required';
                throw new Error(
                    `Gemini account validation required: ${description}. Visit ${validationTier.validationUrl} and try again.`
                );
            }
        }
    }

    _throwIneligibleOrProjectRequired(loadRes) {
        const reasons = Array.isArray(loadRes?.ineligibleTiers)
            ? loadRes.ineligibleTiers
                .map(tier => tier?.reasonMessage?.trim())
                .filter(Boolean)
            : [];

        if (reasons.length > 0) {
            throw new Error(`Gemini account is not eligible: ${reasons.join('; ')}`);
        }

        throw new Error(
            'Gemini requires a Google Cloud project ID for this account. Set the project ID in Settings or export GOOGLE_CLOUD_PROJECT.'
        );
    }

    _getOnboardTier(loadRes) {
        const defaultTier = Array.isArray(loadRes?.allowedTiers)
            ? loadRes.allowedTiers.find(tier => tier?.isDefault)
            : null;

        return defaultTier ?? {
            id: USER_TIER_LEGACY,
            name: null,
        };
    }

    _delayMs(ms) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _requestJson(session, method, url, requestBody, accessToken) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new(method, url);
            message.request_headers.append('Accept', 'application/json');
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
                        reject(this._createHttpError(
                            `Gemini auth failed (HTTP ${statusCode})`,
                            message
                        ));
                        return;
                    }

                    if (statusCode === 429) {
                        reject(this._createHttpError(
                            this._extractErrorMessage(text, 'Gemini rate limited (HTTP 429)'),
                            message
                        ));
                        return;
                    }

                    if (statusCode < 200 || statusCode >= 300) {
                        reject(this._createHttpError(
                            this._extractErrorMessage(text, `Gemini API error (HTTP ${statusCode})`),
                            message
                        ));
                        return;
                    }

                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(new Error(`Failed to fetch Gemini usage: ${e.message}`));
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

    _normalizeQuotaResponse(data, planName, account) {
        const windows = Array.isArray(data?.buckets)
            ? data.buckets
                .map(bucket => this._normalizeBucket(bucket))
                .filter(Boolean)
            : [];

        return {
            windows: this._orderWindows(windows, this._getPanelQuotaStrategy(account)),
            planName,
        };
    }

    _normalizeBucket(bucket) {
        if (!bucket || typeof bucket.remainingFraction !== 'number')
            return null;

        const remainingFraction = Math.max(0, Math.min(1, bucket.remainingFraction));
        const utilization = Math.max(0, Math.min(1, 1 - remainingFraction));
        const remainingAmount = this._parseNumeric(bucket.remainingAmount);

        let limit = null;
        let used = null;

        if (remainingAmount !== null && remainingFraction > 0) {
            const roundedRemaining = Math.max(0, Math.round(remainingAmount));
            limit = Math.max(0, Math.round(remainingAmount / remainingFraction));
            used = Math.max(0, limit - roundedRemaining);
        } else {
            limit = 100;
            used = Math.round(utilization * 100);
        }

        const isPrimary = !bucket.modelId;
        const label = isPrimary ? 'Primary' : this._labelForModel(bucket.modelId);
        const id = isPrimary
            ? WINDOW_PRIMARY
            : `gemini_model_${this._slugify(bucket.modelId)}`;

        return {
            id,
            label,
            used,
            limit,
            utilization,
            resetsAt: this._parseResetTimestamp(bucket.resetTime),
        };
    }

    _parseNumeric(value) {
        if (typeof value === 'number' && Number.isFinite(value))
            return value;

        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed))
                return parsed;
        }

        return null;
    }

    _labelForModel(modelId) {
        const lower = modelId.toLowerCase();
        if (lower.includes('flash-lite') || lower.includes('lite'))
            return 'Lite';
        if (lower.includes('flash'))
            return 'Flash';
        if (lower.includes('pro'))
            return 'Pro';
        return this._sanitizeModelLabel(modelId);
    }

    _sanitizeModelLabel(modelId) {
        const bareModel = modelId
            .replace(/^models\//i, '')
            .split('/')
            .pop();
        const parts = bareModel.split(/[-_]/).filter(Boolean);
        const filtered = parts.filter(part =>
            !/^gemini$/i.test(part) &&
            !/^\d+(\.\d+)?$/.test(part)
        );
        const words = filtered.length > 0 ? filtered : parts;
        const label = words
            .map(word => word[0].toUpperCase() + word.substring(1))
            .join(' ');
        return label || 'Model';
    }

    _slugify(value) {
        return value
            .toLowerCase()
            .replace(/^models\//, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'model';
    }

    _getPanelQuotaStrategy(account) {
        const strategy = account.config?.panelQuotaStrategy;
        const allowed = new Set([
            PANEL_QUOTA_MOST_CONSTRAINED,
            PANEL_QUOTA_POOLED_FIRST,
            PANEL_QUOTA_POOLED_ONLY,
        ]);
        return allowed.has(strategy) ? strategy : PANEL_QUOTA_MOST_CONSTRAINED;
    }

    _orderWindows(windows, strategy) {
        const sorted = [...windows].sort((a, b) => {
            if (b.utilization !== a.utilization)
                return b.utilization - a.utilization;
            if (a.id === WINDOW_PRIMARY) return -1;
            if (b.id === WINDOW_PRIMARY) return 1;
            return a.label.localeCompare(b.label);
        });

        const primary = sorted.find(window => window.id === WINDOW_PRIMARY);
        if (!primary)
            return sorted;

        if (strategy === PANEL_QUOTA_POOLED_ONLY)
            return [primary];

        if (strategy === PANEL_QUOTA_POOLED_FIRST) {
            return [
                primary,
                ...sorted.filter(window => window.id !== WINDOW_PRIMARY),
            ];
        }

        return sorted;
    }
}
