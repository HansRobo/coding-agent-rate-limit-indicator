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
    PANEL_ICON_SIZE,
    DEFAULT_RETRY_AFTER_SECS,
    DEFAULT_ERROR_BACKOFF_SECS,
    SETTINGS_DEBOUNCE_MS,
} from './constants.js';

import {IconCache} from './iconCache.js';

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

        // Debounce timer for settings-triggered refreshes
        this._debounceTimerId = null;

        // Destroy guard for async safety
        this._destroyed = false;

        // HTTP session
        this._session = this._createSession();

        // Icon cache (fetches and caches provider SVG icons)
        this._iconCache = new IconCache(
            this._session,
            () => { if (!this._destroyed) this._updatePanelDisplay(); }
        );

        // --- Build panel widget ---
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-rate-limit-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        // Panel mini bar container (always kept as a persistent child)
        this._panelBarContainer = new St.Widget({
            style_class: 'panel-mini-bar-container',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBarFill = new St.Widget({
            style_class: 'panel-mini-bar-fill',
        });
        this._panelBarContainer.add_child(this._panelBarFill);
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
            if (isOpen) this._buildMenu();
        });

        // --- Start timer and initial fetch ---
        this._timerId = null;
        this._startTimer();
        this._refresh();
        this._prefetchIcons();
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

    // Debounced refresh — cancels any pending scheduled refresh and schedules a new one.
    // Used for settings changes to avoid a burst of requests when the user edits rapidly.
    _scheduleRefresh() {
        if (this._debounceTimerId !== null) {
            GLib.source_remove(this._debounceTimerId);
            this._debounceTimerId = null;
        }
        this._debounceTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SETTINGS_DEBOUNCE_MS,
            () => {
                this._debounceTimerId = null;
                this._refresh();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _recreateSession() {
        try {
            this._session.abort();
        } catch (e) {
            // ignore
        }
        this._session = this._createSession();
        this._scheduleRefresh();
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
            this._updatePanelDisplay();
            break;
        case 'proxy-url':
            this._recreateSession();
            break;
        case 'accounts-json':
        case 'visible-account-ids':
            this._scheduleRefresh();
            this._prefetchIcons();
            break;
        case 'show-provider-icon':
            this._updatePanelDisplay();
            break;
        case 'icon-style':
            this._prefetchIcons();
            this._updatePanelDisplay();
            break;
        }
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        // Account segments (text/icon) are managed by _updatePanelDisplay();
        // only the bar visibility needs to be set here.
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
                    this._updatePanelDisplay();
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
        const prevState = this._accountStates.get(account.id);

        // Skip if still within backoff window
        if (prevState?.backoffUntil && prevState.backoffUntil > Date.now())
            return;

        const provider = createProviderInstance(account.provider);
        if (!provider) {
            this._accountStates.set(account.id, {
                result: null,
                error: `Unknown provider: ${account.provider}`,
                stale: false,
                lastUpdated: null,
                backoffUntil: null,
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
                backoffUntil: null,
            });
        } catch (e) {
            const backoffSecs = e.statusCode === 429 ? (e.retryAfter ?? DEFAULT_RETRY_AFTER_SECS) : DEFAULT_ERROR_BACKOFF_SECS;
            const backoffUntil = Date.now() + backoffSecs * 1000;
            this._accountStates.set(account.id, {
                result: prevState?.result ?? null,
                error: e.message,
                stale: prevState?.result !== null,
                lastUpdated: prevState?.lastUpdated ?? null,
                backoffUntil,
            });
        }
    }

    // --- Icon pre-fetching ---

    _prefetchIcons() {
        const style = this._settings.get_string('icon-style');
        const visibleAccounts = getVisibleAccounts(this._settings);

        const seen = new Set();
        const providers = [];
        for (const account of visibleAccounts) {
            if (!seen.has(account.provider)) {
                seen.add(account.provider);
                const providerClass = getProvider(account.provider);
                if (providerClass) providers.push(providerClass);
            }
        }

        this._iconCache.prefetchAll(providers, style);
    }

    // --- Panel Display ---

    _updatePanelDisplay() {
        const mode = this._settings.get_string('display-mode');
        const showIcons = this._settings.get_boolean('show-provider-icon');
        const iconStyle = this._settings.get_string('icon-style');
        const visibleAccounts = getVisibleAccounts(this._settings);
        const showContent = (mode === DISPLAY_MODE_TEXT || mode === DISPLAY_MODE_BOTH);

        // Remove existing dynamic account segments (all children except the bar container)
        const toRemove = [];
        for (let i = 0; i < this._panelBox.get_n_children(); i++) {
            const child = this._panelBox.get_child_at_index(i);
            if (child !== this._panelBarContainer)
                toRemove.push(child);
        }
        for (const child of toRemove)
            this._panelBox.remove_child(child);

        if (visibleAccounts.length === 0) {
            if (showContent) {
                this._panelBox.insert_child_at_index(
                    new St.Label({
                        style_class: 'panel-rate-limit-label',
                        text: 'RL: --',
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                    0
                );
            }
            this._setPanelBarFraction(0);
            return;
        }

        let primaryUtilization = 0;
        let accountCount = 0;
        let insertIdx = 0;

        for (let i = 0; i < visibleAccounts.length; i++) {
            const account = visibleAccounts[i];
            const state = this._accountStates.get(account.id);
            const providerClass = getProvider(account.provider);

            // Build status text
            let statusText;
            if (!state || !state.result || state.result.windows.length === 0) {
                statusText = state?.error ? 'Err' : '--';
            } else {
                const primaryWindow = state.result.windows[0];
                const pct = Math.round(primaryWindow.utilization * 100);
                primaryUtilization += primaryWindow.utilization;
                accountCount++;

                // Disambiguate when multiple accounts share the same provider
                const sameProvider = visibleAccounts.filter(
                    a => a.provider === account.provider
                );
                if (sameProvider.length > 1) {
                    const name = account.name?.trim() || '??';
                    const initials = name
                        .split(/\s+/)
                        .filter(w => w.length > 0)
                        .map(w => w[0])
                        .join('')
                        .toUpperCase()
                        .substring(0, 2) || '??';
                    statusText = `(${initials}): ${pct}%`;
                } else {
                    statusText = `: ${pct}%`;
                }
            }

            if (showContent) {
                // Add separator before second+ accounts
                if (i > 0) {
                    this._panelBox.insert_child_at_index(
                        new St.Label({
                            style_class: 'panel-rate-limit-label',
                            text: ' | ',
                            y_align: Clutter.ActorAlign.CENTER,
                        }),
                        insertIdx++
                    );
                }

                // Account segment: icon (or text fallback) + status
                const segment = new St.BoxLayout({
                    style_class: 'panel-account-segment',
                    y_align: Clutter.ActorAlign.CENTER,
                });

                // Provider icon or text fallback
                let iconWidget = null;
                if (showIcons && providerClass) {
                    let url;
                    try { url = providerClass.getIconUrl(iconStyle); } catch (e) { /* no icon */ }

                    if (url) {
                        const gicon = this._iconCache.getIcon(providerClass.id, url, iconStyle);
                        if (gicon) {
                            iconWidget = new St.Icon({
                                gicon,
                                icon_size: PANEL_ICON_SIZE,
                                style_class: 'panel-provider-icon',
                                y_align: Clutter.ActorAlign.CENTER,
                            });
                        }
                    }
                }

                if (!iconWidget) {
                    // Text fallback
                    const fallback = providerClass
                        ? providerClass.shortLabel
                        : account.provider.toUpperCase().substring(0, 2);
                    iconWidget = new St.Label({
                        style_class: 'panel-rate-limit-label',
                        text: fallback,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                }

                segment.add_child(iconWidget);
                segment.add_child(new St.Label({
                    style_class: 'panel-rate-limit-label',
                    text: statusText,
                    y_align: Clutter.ActorAlign.CENTER,
                }));

                this._panelBox.insert_child_at_index(segment, insertIdx++);
            }
        }

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
            const noAccountItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
            noAccountItem.add_child(new St.Label({
                style_class: 'm3-empty-label',
                text: 'No accounts configured',
            }));
            this.menu.addMenuItem(noAccountItem);
        } else {
            for (const account of visibleAccounts)
                this._addSingleAccountSection(account);
        }

        // Separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Compact action row: Refresh + Settings as pill buttons side by side
        const actionItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        const actionBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style: 'spacing: 8px;',
        });

        const refreshBtn = new St.BoxLayout({
            style_class: 'm3-pill-button m3-pill-button-secondary',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        refreshBtn.add_child(new St.Label({
            text: '↺ Refresh',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        refreshBtn.connect('button-release-event', () => {
            this._refresh();
            this.menu.close();
        });
        actionBox.add_child(refreshBtn);

        const settingsBtn = new St.BoxLayout({
            style_class: 'm3-pill-button m3-pill-button-secondary',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        settingsBtn.add_child(new St.Label({
            text: '⚙ Settings',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        settingsBtn.connect('button-release-event', () => {
            this._openPrefs();
            this.menu.close();
        });
        actionBox.add_child(settingsBtn);

        actionItem.add_child(actionBox);
        this.menu.addMenuItem(actionItem);
    }

    _addSingleAccountSection(account) {
        const providerClass = getProvider(account.provider);
        const state = this._accountStates.get(account.id);

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        item.add_style_class_name('m3-account-card');
        const outerBox = new St.BoxLayout({vertical: true, x_expand: true});

        // Header row: name + provider pill + timestamp
        const headerRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style: 'spacing: 6px;',
        });

        const nameLabel = new St.Label({
            style_class: 'm3-account-name',
            text: account.name,
            x_expand: true,
        });
        headerRow.add_child(nameLabel);

        if (providerClass) {
            headerRow.add_child(new St.Label({
                style_class: `m3-provider-pill m3-provider-pill-${providerClass.cssClass}`,
                text: providerClass.displayName,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        if (state?.lastUpdated) {
            const suffix = state.stale ? ' (stale)' : '';
            headerRow.add_child(new St.Label({
                style_class: 'm3-updated-label',
                text: `${this._formatTimeAgo(state.lastUpdated)}${suffix}`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        outerBox.add_child(headerRow);

        if (state?.error && !state?.result) {
            outerBox.add_child(new St.Label({
                style_class: 'm3-error-label',
                text: `Error: ${state.error}`,
            }));
        } else if (!state || !state.result) {
            outerBox.add_child(new St.Label({
                style_class: 'm3-loading-label',
                text: 'Loading...',
            }));
        } else {
            for (const window of state.result.windows)
                outerBox.add_child(this._buildCompactWindowRow(window));
            if (state.error && state.stale) {
                outerBox.add_child(new St.Label({
                    style_class: 'm3-warn-label',
                    text: `Last error: ${state.error}`,
                }));
            }
        }

        item.add_child(outerBox);
        this.menu.addMenuItem(item);
    }

    _buildCompactWindowRow(window) {
        const BAR_WIDTH = 150;
        const BAR_HEIGHT = 6;

        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Short label: "5h", "7d", "wk", etc.
        const labelWidget = new St.Label({
            style_class: 'm3-window-label',
            text: this._getShortWindowLabel(window.label),
            y_align: Clutter.ActorAlign.CENTER,
        });
        labelWidget.set_width(24);
        row.add_child(labelWidget);

        // Inline progress bar
        const barContainer = new St.Widget({
            style_class: 'm3-bar-container',
            y_align: Clutter.ActorAlign.CENTER,
        });
        barContainer.set_width(BAR_WIDTH);
        barContainer.set_height(BAR_HEIGHT);
        const barFill = new St.Widget({
            style_class: `m3-bar-fill ${this._getUsageColorClass(window.utilization)}`,
        });
        barFill.set_width(Math.max(0, Math.min(BAR_WIDTH, Math.round(window.utilization * BAR_WIDTH))));
        barFill.set_height(BAR_HEIGHT);
        barContainer.add_child(barFill);
        row.add_child(barContainer);

        // Percentage
        const pct = Math.round(window.utilization * 100);
        const pctLabel = new St.Label({
            style_class: 'm3-pct-label',
            text: `${pct}%`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        pctLabel.set_width(36);
        row.add_child(pctLabel);

        if (window.resetsAt) {
            row.add_child(new St.Label({
                style_class: 'm3-reset-label',
                text: `↻${this._formatResetTime(window.resetsAt)}`,
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        } else {
            row.add_child(new St.Widget({x_expand: true}));
        }

        return row;
    }

    // --- Formatting Helpers ---

    _getUsageColorClass(utilization) {
        if (utilization >= THRESHOLD_HIGH) return 'usage-critical';
        if (utilization >= THRESHOLD_MEDIUM) return 'usage-high';
        if (utilization >= THRESHOLD_LOW) return 'usage-medium';
        return 'usage-low';
    }

    _getShortWindowLabel(label) {
        const lower = label.toLowerCase();
        const match = label.match(/(\d+)/);
        if (lower.includes('hour')) return match ? `${match[1]}h` : label.substring(0, 2);
        if (lower.includes('day')) return match ? `${match[1]}d` : label.substring(0, 2);
        if (lower.includes('week')) return 'wk';
        if (lower.includes('month')) return 'mo';
        if (lower.includes('primary')) return '1°';
        return label.substring(0, 3);
    }

    _formatResetTime(resetDate) {
        try {
            const diffMs = resetDate.getTime() - Date.now();
            if (diffMs <= 0) return 'now';

            const totalMinutes = Math.floor(diffMs / 60000);
            const days = Math.floor(totalMinutes / 1440);
            const hours = Math.floor((totalMinutes % 1440) / 60);
            const minutes = totalMinutes % 60;

            if (days > 0) return `${days}d${hours}h`;
            if (hours > 0) return `${hours}h${minutes}m`;
            return `${minutes}m`;
        } catch (e) {
            return '--';
        }
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

        if (this._debounceTimerId !== null) {
            GLib.source_remove(this._debounceTimerId);
            this._debounceTimerId = null;
        }

        this._iconCache?.destroy();
        this._iconCache = null;

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
