// Coding Agent Rate Limit Indicator - GNOME Shell Extension
// Main entry point: panel indicator, popup menu, and refresh logic.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    DEFAULT_REFRESH_INTERVAL,
    HTTP_TIMEOUT,
    DISPLAY_MODE_TEXT,
    DISPLAY_MODE_BAR,
    DISPLAY_MODE_BOTH,
    THRESHOLD_LOW,
    THRESHOLD_MEDIUM,
    THRESHOLD_HIGH,
} from './constants.js';

import {
    getVisibleAccounts,
    getAccountDisplayLabel,
} from './accounts.js';

import {getToken} from './secret.js';

import {
    getProvider,
    createProviderInstance,
} from './providerRegistry.js';


// --- Indicator Widget ---

const RateLimitIndicator = GObject.registerClass(
class RateLimitIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPrefs) {
        super._init(0.5, 'Coding Agent Rate Limit Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPrefs = openPrefs;

        // Per-account state: Map<accountId, { result, error, stale, lastUpdated }>
        this._accountStates = new Map();

        // Refresh guard
        this._refreshInFlight = false;

        // Destroy guard for async safety
        this._destroyed = false;

        // HTTP session
        this._session = this._createSession();

        // --- Build panel widget ---
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-rate-limit-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        // Panel label (always present)
        this._panelLabel = new St.Label({
            style_class: 'panel-rate-limit-label',
            text: 'RL: --',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Panel mini bar container
        this._panelBarContainer = new St.Widget({
            style_class: 'panel-mini-bar-container',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBarFill = new St.Widget({
            style_class: 'panel-mini-bar-fill',
        });
        this._panelBarContainer.add_child(this._panelBarFill);

        this._panelBox.add_child(this._panelLabel);
        this._panelBox.add_child(this._panelBarContainer);

        // Apply initial display mode
        this._updateDisplayMode();

        // --- Build popup menu ---
        this._buildMenu();

        // --- Connect settings ---
        this._settingsChangedId = this._settings.connect('changed', (s, key) => {
            this._onSettingChanged(key);
        });

        // --- Refresh on menu open ---
        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) this._rebuildMenu();
        });

        // --- Start timer and initial fetch ---
        this._timerId = null;
        this._startTimer();
        this._refresh();
    }

    // --- HTTP Session ---

    _createSession() {
        const session = new Soup.Session({timeout: HTTP_TIMEOUT});

        const proxyUrl = this._settings.get_string('proxy-url');
        if (proxyUrl && proxyUrl.trim() !== '') {
            const resolver = Gio.SimpleProxyResolver.new(proxyUrl.trim(), null);
            session.set_proxy_resolver(resolver);
        }

        return session;
    }

    _recreateSession() {
        try {
            this._session.abort();
        } catch (e) {
            // ignore
        }
        this._session = this._createSession();
        this._refresh();
    }

    // --- Timer ---

    _startTimer() {
        this._stopTimer();
        const interval = this._settings.get_int('refresh-interval') || DEFAULT_REFRESH_INTERVAL;
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    // --- Settings ---

    _onSettingChanged(key) {
        switch (key) {
        case 'refresh-interval':
            this._startTimer();
            break;
        case 'display-mode':
            this._updateDisplayMode();
            break;
        case 'proxy-url':
            this._recreateSession();
            break;
        case 'accounts-json':
        case 'visible-account-ids':
            this._refresh();
            break;
        case 'show-provider-icon':
        case 'icon-style':
            this._updatePanelDisplay();
            break;
        }
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        this._panelLabel.visible = (mode === DISPLAY_MODE_TEXT || mode === DISPLAY_MODE_BOTH);
        this._panelBarContainer.visible = (mode === DISPLAY_MODE_BAR || mode === DISPLAY_MODE_BOTH);
    }

    // --- Data Fetching ---

    async _refresh() {
        if (this._refreshInFlight || this._destroyed) return;
        this._refreshInFlight = true;

        try {
            const visibleAccounts = getVisibleAccounts(this._settings);

            if (visibleAccounts.length === 0) {
                if (!this._destroyed)
                    this._panelLabel.set_text('RL: No accounts');
                this._refreshInFlight = false;
                return;
            }

            // Fetch all accounts in parallel
            const promises = visibleAccounts.map(account =>
                this._fetchAccount(account)
            );
            await Promise.allSettled(promises);
        } catch (e) {
            console.error('Rate Limit Indicator: Refresh error:', e.message);
        } finally {
            this._refreshInFlight = false;
            if (!this._destroyed)
                this._updatePanelDisplay();
        }
    }

    async _fetchAccount(account) {
        const provider = createProviderInstance(account.provider);
        if (!provider) {
            this._accountStates.set(account.id, {
                result: null,
                error: `Unknown provider: ${account.provider}`,
                stale: false,
                lastUpdated: null,
            });
            return;
        }

        try {
            const result = await provider.fetchUsage(
                account,
                this._session,
                (accountId) => getToken(accountId)
            );
            this._accountStates.set(account.id, {
                result,
                error: null,
                stale: false,
                lastUpdated: new Date(),
            });
        } catch (e) {
            const prevState = this._accountStates.get(account.id);
            this._accountStates.set(account.id, {
                result: prevState?.result ?? null,
                error: e.message,
                stale: prevState?.result !== null,
                lastUpdated: prevState?.lastUpdated ?? null,
            });
        }
    }

    // --- Panel Display ---

    _updatePanelDisplay() {
        const visibleAccounts = getVisibleAccounts(this._settings);

        if (visibleAccounts.length === 0) {
            this._panelLabel.set_text('RL: --');
            this._setPanelBarFraction(0);
            return;
        }

        const parts = [];
        let primaryUtilization = 0;
        let accountCount = 0;

        for (const account of visibleAccounts) {
            const state = this._accountStates.get(account.id);
            const providerClass = getProvider(account.provider);
            const label = getAccountDisplayLabel(
                account,
                visibleAccounts,
                {get: getProvider}
            );

            if (!state || !state.result || state.result.windows.length === 0) {
                if (state?.error) {
                    parts.push(`${label}: Err`);
                } else {
                    parts.push(`${label}: --`);
                }
                continue;
            }

            // Use the first (primary) window utilization
            const primaryWindow = state.result.windows[0];
            const pct = Math.round(primaryWindow.utilization * 100);
            parts.push(`${label}: ${pct}%`);

            primaryUtilization += primaryWindow.utilization;
            accountCount++;
        }

        this._panelLabel.set_text(parts.join(' | '));

        // Mini bar shows average utilization across all accounts
        const avgUtilization = accountCount > 0
            ? primaryUtilization / accountCount
            : 0;
        this._setPanelBarFraction(avgUtilization);
    }

    _setPanelBarFraction(fraction) {
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        const widthPx = Math.round(clampedFraction * 50);
        this._panelBarFill.set_width(widthPx);
    }

    // --- Popup Menu ---

    _buildMenu() {
        this.menu.removeAll();
        this.menu.box.add_style_class_name('rate-limit-menu');

        const visibleAccounts = getVisibleAccounts(this._settings);

        if (visibleAccounts.length === 0) {
            const noAccountItem = new PopupMenu.PopupMenuItem(
                'No accounts configured', {reactive: false}
            );
            this.menu.addMenuItem(noAccountItem);
        } else {
            this._addAccountSections(visibleAccounts);
        }

        // Separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Refresh button
        const refreshItem = new PopupMenu.PopupMenuItem('Refresh Now');
        refreshItem.connect('activate', () => {
            this._refresh();
        });
        this.menu.addMenuItem(refreshItem);

        // Settings button
        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPrefs();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _rebuildMenu() {
        this._buildMenu();
    }

    _addAccountSections(visibleAccounts) {
        for (let i = 0; i < visibleAccounts.length; i++) {
            if (i > 0) {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }

            const account = visibleAccounts[i];
            this._addSingleAccountSection(account, visibleAccounts);
        }
    }

    _addSingleAccountSection(account, allVisible) {
        const providerClass = getProvider(account.provider);
        const state = this._accountStates.get(account.id);

        // Account header
        const headerBox = new St.BoxLayout({vertical: false});

        const nameLabel = new St.Label({
            style_class: 'rate-limit-account-header',
            text: account.name,
        });
        headerBox.add_child(nameLabel);

        // Provider tag
        if (providerClass) {
            const cssClass = `rate-limit-provider-tag rate-limit-provider-tag-${providerClass.cssClass}`;
            const tagLabel = new St.Label({
                style_class: cssClass,
                text: providerClass.displayName,
                y_align: Clutter.ActorAlign.CENTER,
            });
            headerBox.add_child(tagLabel);
        }

        // Stale indicator
        if (state?.stale) {
            const staleLabel = new St.Label({
                style_class: 'rate-limit-stale',
                text: '  (stale)',
                y_align: Clutter.ActorAlign.CENTER,
            });
            headerBox.add_child(staleLabel);
        }

        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        // Error state
        if (state?.error && !state?.result) {
            const errorItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const errorLabel = new St.Label({
                style_class: 'rate-limit-error',
                text: `Error: ${state.error}`,
            });
            errorItem.add_child(errorLabel);
            this.menu.addMenuItem(errorItem);
            return;
        }

        // No data yet
        if (!state || !state.result) {
            const loadingItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            loadingItem.add_child(new St.Label({text: 'Loading...'}));
            this.menu.addMenuItem(loadingItem);
            return;
        }

        // Usage windows
        for (const window of state.result.windows) {
            this._addWindowSection(window);
        }

        // Last updated
        if (state.lastUpdated) {
            const updatedItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const timeStr = this._formatTimeAgo(state.lastUpdated);
            updatedItem.add_child(new St.Label({
                style_class: 'rate-limit-status-line',
                text: `Updated ${timeStr}`,
            }));
            this.menu.addMenuItem(updatedItem);
        }

        // Error message (for stale state)
        if (state.error && state.stale) {
            const warnItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            warnItem.add_child(new St.Label({
                style_class: 'rate-limit-error',
                text: `Last error: ${state.error}`,
            }));
            this.menu.addMenuItem(warnItem);
        }
    }

    _addWindowSection(window) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const box = new St.BoxLayout({vertical: true});

        // Header row: label + percentage
        const headerRow = new St.BoxLayout({vertical: false});
        const windowLabel = new St.Label({
            style_class: 'rate-limit-window-label',
            text: window.label,
            x_expand: true,
        });
        headerRow.add_child(windowLabel);

        const pct = Math.round(window.utilization * 100);
        const valueText = window.used !== null && window.limit !== null
            ? `${this._formatNumber(window.used)} / ${this._formatNumber(window.limit)} (${pct}%)`
            : `${pct}%`;

        const valueLabel = new St.Label({
            style_class: 'rate-limit-window-value',
            text: valueText,
        });
        headerRow.add_child(valueLabel);
        box.add_child(headerRow);

        // Progress bar
        const barContainer = new St.Widget({
            style_class: 'rate-limit-bar-container',
        });
        const barFill = new St.Widget({
            style_class: `rate-limit-bar-fill ${this._getUsageColorClass(window.utilization)}`,
        });
        const fillWidth = Math.round(window.utilization * 280);
        barFill.set_width(Math.max(0, Math.min(280, fillWidth)));
        barContainer.add_child(barFill);
        box.add_child(barContainer);

        // Reset time
        if (window.resetsAt) {
            const resetText = `Resets in ${this._formatResetTime(window.resetsAt)}`;
            const resetLabel = new St.Label({
                style_class: 'rate-limit-reset-label',
                text: resetText,
            });
            box.add_child(resetLabel);
        }

        item.add_child(box);
        this.menu.addMenuItem(item);
    }

    // --- Formatting Helpers ---

    _getUsageColorClass(utilization) {
        if (utilization >= THRESHOLD_HIGH) return 'usage-critical';
        if (utilization >= THRESHOLD_MEDIUM) return 'usage-high';
        if (utilization >= THRESHOLD_LOW) return 'usage-medium';
        return 'usage-low';
    }

    _formatResetTime(resetDate) {
        try {
            const now = new Date();
            const diffMs = resetDate.getTime() - now.getTime();

            if (diffMs <= 0) return 'now';

            const totalMinutes = Math.floor(diffMs / 60000);
            const days = Math.floor(totalMinutes / 1440);
            const hours = Math.floor((totalMinutes % 1440) / 60);
            const minutes = totalMinutes % 60;

            if (days > 0) return `${days}d ${hours}h`;
            if (hours > 0) return `${hours}h ${minutes}m`;
            return `${minutes}m`;
        } catch (e) {
            return '--';
        }
    }

    _formatNumber(n) {
        if (n === null || n === undefined) return '--';
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
        return n.toString();
    }

    _formatTimeAgo(date) {
        const diffMs = Date.now() - date.getTime();
        const seconds = Math.floor(diffMs / 1000);

        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m ago`;
    }

    // --- Cleanup ---

    destroy() {
        this._destroyed = true;
        this._stopTimer();

        try {
            this._session.abort();
        } catch (e) {
            // ignore
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }

        this._accountStates.clear();
        super.destroy();
    }
});


// --- Extension Entry Point ---

export default class CodingAgentRateLimitExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new RateLimitIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
