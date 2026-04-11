// GLM (z.ai) provider.
// Fetches usage data from the z.ai monitor API.
//
// z.ai limit identification (by type + unit + number):
//   TOKENS_LIMIT + unit=3 + number=5  → 5-hour token window
//   TOKENS_LIMIT + unit=6 + number=1  → weekly token window
//   TIME_LIMIT   + unit=5 + number=1  → monthly MCP tool window

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {BaseProvider} from './base.js';
import {
    PROVIDER_GLM,
    GLM_API_URL,
    WINDOW_FIVE_HOUR,
    WINDOW_WEEKLY,
    WINDOW_MONTHLY,
} from '../constants.js';

export class GlmProvider extends BaseProvider {
    static get id() {
        return PROVIDER_GLM;
    }

    static get displayName() {
        return 'GLM';
    }

    static get shortLabel() {
        return 'GL';
    }

    static getIconUrl(_style) {
        return 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg';
    }

    static get supportsAutoDetect() {
        return false;
    }

    static get requiresManualToken() {
        return true;
    }

    static get tokenFieldLabel() {
        return 'API key';
    }

    static getDefaultConfig() {
        return {};
    }

    static getConfigFields() {
        return [];
    }

    async fetchUsage(account, session, getToken) {
        const token = await getToken(account.id);

        if (!token) {
            throw new Error('No GLM API key available. Please enter your API key in the settings panel.');
        }

        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', GLM_API_URL);
            message.request_headers.append('Authorization', `Bearer ${token.trim()}`);
            message.request_headers.append('Accept', 'application/json');

            session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (sess, result) => {
                    try {
                        const bytes = sess.send_and_read_finish(result);
                        const statusCode = message.get_status();

                        if (statusCode === 401 || statusCode === 403) {
                            reject(new Error(`Auth failed (HTTP ${statusCode}). Check your API key.`));
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
                        reject(new Error(`Failed to fetch GLM usage: ${e.message}`));
                    }
                }
            );
        });
    }

    /**
     * Normalize the z.ai monitor API response into our standard format.
     *
     * Expected response:
     * {
     *   code: 200,
     *   data: {
     *     level: "lite",
     *     limits: [
     *       { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 26, nextResetTime: 1775931014695 },
     *       { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 5,  nextResetTime: 1776515833997 },
     *       { type: "TIME_LIMIT",   unit: 5, number: 1, percentage: 0,  usage: 100, currentValue: 0,
     *         nextResetTime: 1778503033976, usageDetails: [...] }
     *     ]
     *   }
     * }
     */
    _normalizeResponse(data) {
        if (data.code !== 200) {
            throw new Error(`GLM API error: ${data.msg ?? 'Unknown error'}`);
        }

        const limits = data.data?.limits ?? [];
        const windows = [];

        for (const limit of limits) {
            const windowDef = this._identifyWindow(limit);
            if (!windowDef)
                continue;

            windows.push({
                id: windowDef.id,
                label: windowDef.label,
                used: limit.currentValue ?? null,
                limit: limit.usage ?? null,
                utilization: (limit.percentage ?? 0) / 100,
                resetsAt: limit.nextResetTime ? new Date(limit.nextResetTime) : null,
            });
        }

        // Sort: 5-hour first, weekly second, monthly last
        const order = {[WINDOW_FIVE_HOUR]: 0, [WINDOW_WEEKLY]: 1, [WINDOW_MONTHLY]: 2};
        windows.sort((a, b) => (order[a.id] ?? 99) - (order[b.id] ?? 99));

        return {
            windows,
            planName: data.data?.level ?? null,
        };
    }

    /**
     * Identify a z.ai limit entry by its type/unit/number combination.
     * Returns {id, label} or null if unrecognized.
     */
    _identifyWindow(limit) {
        const {type, unit, number} = limit;
        if (type === 'TOKENS_LIMIT' && unit === 3 && number === 5)
            return {id: WINDOW_FIVE_HOUR, label: '5-Hour'};
        if (type === 'TOKENS_LIMIT' && unit === 6 && number === 1)
            return {id: WINDOW_WEEKLY, label: 'Weekly'};
        if (type === 'TIME_LIMIT' && unit === 5 && number === 1)
            return {id: WINDOW_MONTHLY, label: 'Monthly'};
        return null;
    }
}
