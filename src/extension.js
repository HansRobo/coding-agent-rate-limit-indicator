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
    PANEL_TIME_DISPLAY_RECOVERY,
    PANEL_TIME_DISPLAY_REMAINING_COLON,
    PANEL_WINDOW_ALL,
    PANEL_WINDOW_WORST,
    THRESHOLD_LOW,
    THRESHOLD_MEDIUM,
    THRESHOLD_HIGH,
    PANEL_ICON_SIZE,
    PANEL_VBAR_HEIGHT,
    MENU_BAR_WIDTH,
    MENU_BAR_HEIGHT,
    DEFAULT_RETRY_AFTER_SECS,
    DEFAULT_ERROR_BACKOFF_SECS,
    SETTINGS_DEBOUNCE_MS,
    INTER_ACCOUNT_DELAY_MS,
} from './constants.js';

import {IconCache} from './iconCache.js';

import {
    getVisibleAccounts,
    getAccountDisplayLabel,
    migrateVisibilitySettings,
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

        // Inter-account throttle timer (tracked so destroy() can cancel it
        // and release the awaiting refresh loop).
        this._interAccountTimerId = null;
        this._interAccountResolve = null;

        // Destroy guard for async safety
        this._destroyed = false;

        // HTTP session
        this._session = this._createSession();

        // Icon cache (fetches and caches provider SVG icons).
        // Pass a session getter so it follows session recreation (proxy changes).
        this._iconCache = new IconCache(
            () => this._session,
            () => { if (!this._destroyed) this._updatePanelDisplay(); }
        );

        // --- Build panel widget ---
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-rate-limit-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        // Apply initial display mode
        this._updatePanelDisplay();

        // --- Build popup menu ---
        this._buildMenu();

        // --- Track system color scheme for menu text color ---
        this._stSettings = St.Settings.get();
        this._colorSchemeHandlerId = this._stSettings.connect(
            'notify::color-scheme',
            () => this._applyMenuTextColor()
        );
        this._ifaceSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        this._ifaceColorSchemeId = this._ifaceSettings.connect(
            'changed::color-scheme',
            () => this._applyMenuTextColor()
        );

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
        this._panelTimeTimerId = null;
        this._startTimer();
        this._startPanelTimeTimer();
        this._refresh();
        this._prefetchIcons();
    }

    // --- HTTP Session ---

    _createSession() {
        const session = new Soup.Session({timeout: HTTP_TIMEOUT});
        session.user_agent = 'CodingAgentRateLimitIndicator/1.0';

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

    _startPanelTimeTimer() {
        this._stopPanelTimeTimer();
        this._panelTimeTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            60,
            () => {
                this._updatePanelDisplay();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopPanelTimeTimer() {
        if (this._panelTimeTimerId !== null) {
            GLib.source_remove(this._panelTimeTimerId);
            this._panelTimeTimerId = null;
        }
    }

    // --- Settings ---

    _onSettingChanged(key) {
        switch (key) {
        case 'refresh-interval':
            this._startTimer();
            break;
        case 'display-mode':
        case 'panel-time-display-mode':
            this._updatePanelDisplay();
            break;
        case 'proxy-url':
            this._recreateSession();
            break;
        case 'accounts-json':
        case 'hidden-account-ids':
            this._scheduleRefresh();
            this._prefetchIcons();
            break;
        case 'credential-revision':
            this._scheduleRefresh();
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

    // --- Data Fetching ---

    async _refresh() {
        if (this._refreshInFlight || this._destroyed) return;
        this._refreshInFlight = true;
        if (this.menu.isOpen) this._buildMenu();

        try {
            const visibleAccounts = getVisibleAccounts(this._settings);

            if (visibleAccounts.length === 0) {
                if (!this._destroyed)
                    this._updatePanelDisplay();
                this._refreshInFlight = false;
                return;
            }

            // Fetch all accounts sequentially to avoid triggering concurrency rate limits
            for (let i = 0; i < visibleAccounts.length; i++) {
                if (this._destroyed) break;
                const fetched = await this._fetchAccount(visibleAccounts[i]);
                // Reflect each completed fetch live while the menu is open.
                if (!this._destroyed && this.menu.isOpen)
                    this._buildMenu();
                // Throttle only between actual network fetches; skip the delay
                // when an account was backoff-skipped or after the last account.
                const isLast = i === visibleAccounts.length - 1;
                if (fetched && !isLast && !this._destroyed)
                    await this._delayBetweenAccounts();
            }
        } catch (e) {
            console.error('Rate Limit Indicator: Refresh error:', e.message);
        } finally {
            this._refreshInFlight = false;
            if (!this._destroyed) {
                this._updatePanelDisplay();
                if (this.menu.isOpen) this._buildMenu();
            }
        }
    }

    // Throttle between sequential account fetches. The timer is tracked so
    // destroy() can cancel it and resolve the awaiting promise (removing the
    // source without resolving would leave the refresh loop hung).
    _delayBetweenAccounts() {
        return new Promise(resolve => {
            this._interAccountResolve = resolve;
            this._interAccountTimerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                INTER_ACCOUNT_DELAY_MS,
                () => {
                    this._interAccountTimerId = null;
                    this._interAccountResolve = null;
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }
            );
        });
    }

    // Emit a desktop notification when a window crosses the high-usage
    // threshold (rising edge) or resets back below it. Only fires on a fresh
    // successful fetch with prior data, so backoff/error refreshes never notify
    // and the first load after enabling does not produce a burst.
    _maybeNotify(account, prevResult, newResult) {
        if (!prevResult || !newResult) return;
        if (!this._settings.get_boolean('enable-notifications')) return;

        const prevById = new Map(prevResult.windows.map(w => [w.id, w]));
        const name = account.name?.trim() || 'Account';

        for (const win of newResult.windows) {
            const prev = prevById.get(win.id);
            if (!prev) continue;

            const crossedUp = prev.utilization < THRESHOLD_HIGH &&
                win.utilization >= THRESHOLD_HIGH;
            const crossedDown = prev.utilization >= THRESHOLD_HIGH &&
                win.utilization < THRESHOLD_HIGH;
            if (!crossedUp && !crossedDown) continue;

            const pct = Math.round(win.utilization * 100);
            try {
                if (crossedUp) {
                    Main.notify(
                        `${name}: ${win.label} limit nearly reached`,
                        `Usage is at ${pct}%.`
                    );
                } else {
                    Main.notify(
                        `${name}: ${win.label} reset`,
                        `Usage is back down to ${pct}%.`
                    );
                }
            } catch (e) {
                console.error('Rate Limit Indicator: notify failed:', e.message);
            }
        }
    }

    // Returns true if a network fetch was attempted, false if the account was
    // skipped (backoff window active, or unknown provider).
    async _fetchAccount(account) {
        const prevState = this._accountStates.get(account.id);

        // Skip if still within backoff window
        if (prevState?.backoffUntil && prevState.backoffUntil > Date.now())
            return false;

        const provider = createProviderInstance(account.provider);
        if (!provider) {
            this._accountStates.set(account.id, {
                result: null,
                error: `Unknown provider: ${account.provider}`,
                stale: false,
                lastUpdated: null,
                backoffUntil: null,
            });
            return false;
        }

        try {
            const result = await provider.fetchUsage(
                account,
                this._session,
                (accountId) => getToken(accountId)
            );
            this._maybeNotify(account, prevState?.result ?? null, result);
            this._accountStates.set(account.id, {
                result,
                error: null,
                stale: false,
                lastUpdated: new Date(),
                backoffUntil: null,
            });
        } catch (e) {
            const isRateLimit = e.statusCode === 429;
            const backoffSecs = isRateLimit ? (e.retryAfter ?? DEFAULT_RETRY_AFTER_SECS) : DEFAULT_ERROR_BACKOFF_SECS;
            const backoffUntil = Date.now() + backoffSecs * 1000;

            this._accountStates.set(account.id, {
                result: prevState?.result ?? null,
                // Suppress error message for 429s to avoid distracting the user.
                // We just silently backoff and show the stale data.
                error: isRateLimit ? null : e.message,
                stale: prevState?.result != null,
                lastUpdated: prevState?.lastUpdated ?? null,
                backoffUntil,
            });
        }
        return true;
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
        const showBars = (mode === DISPLAY_MODE_BAR || mode === DISPLAY_MODE_BOTH);

        this._panelBox.remove_all_children();

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
            return;
        }

        const winMode = this._settings.get_string('panel-window-mode');

        for (let i = 0; i < visibleAccounts.length; i++) {
            const account = visibleAccounts[i];
            const state = this._accountStates.get(account.id);
            const providerClass = getProvider(account.provider);
            const windows = state?.result?.windows ?? [];
            const displayWindows = this._selectPanelWindows(windows, winMode);
            const barUtilization = displayWindows.length
                ? Math.max(...displayWindows.map(w => w.utilization))
                : 0;

            if (i > 0 && showContent) {
                this._panelBox.add_child(new St.Label({
                    style_class: 'panel-rate-limit-label',
                    text: ' | ',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            const segment = new St.BoxLayout({
                style_class: 'panel-account-segment',
                y_align: Clutter.ActorAlign.CENTER,
            });

            if (showBars)
                segment.add_child(this._createVerticalBar(barUtilization));

            if (showContent) {
                // Disambiguate when multiple accounts share the same provider
                const sameProvider = visibleAccounts.filter(
                    a => a.provider === account.provider
                );
                const prefix = sameProvider.length > 1
                    ? `(${this._accountInitials(account)})`
                    : '';
                const isHardError = displayWindows.length === 0 && Boolean(state?.error);
                const isStale = Boolean(state?.stale);
                const statusText = this._buildPanelStatusText(
                    displayWindows, prefix, Boolean(state?.error)
                );
                // Stale data (e.g. during backoff) is marked with a leading '~'
                // and a dimmed segment; hard errors get an error color.
                const displayText = isStale ? `~${statusText}` : statusText;

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
                    const fallback = providerClass
                        ? providerClass.shortLabel
                        : String(account.provider).toUpperCase().substring(0, 2);
                    iconWidget = new St.Label({
                        style_class: 'panel-rate-limit-label',
                        text: fallback,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                }

                const statusLabel = new St.Label({
                    style_class: 'panel-rate-limit-label',
                    text: displayText,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                if (isHardError)
                    statusLabel.add_style_class_name('panel-error-label');

                segment.add_child(iconWidget);
                segment.add_child(statusLabel);

                if (isStale)
                    segment.set_opacity(150);
            }

            this._panelBox.add_child(segment);
        }
    }

    // Pick the usage windows shown in the panel for one account, per the
    // panel-window-mode setting. Returns [] when no data is available.
    _selectPanelWindows(windows, mode) {
        if (!windows.length) return [];
        if (mode === PANEL_WINDOW_ALL) return windows;
        if (mode === PANEL_WINDOW_WORST) {
            return [windows.reduce((worst, w) =>
                (w.utilization > worst.utilization ? w : worst))];
        }
        return [windows[0]]; // PANEL_WINDOW_PRIMARY (default)
    }

    _accountInitials(account) {
        const name = account.name?.trim() || '??';
        return name
            .split(/\s+/)
            .filter(w => w.length > 0)
            .map(w => w[0])
            .join('')
            .toUpperCase()
            .substring(0, 2) || '??';
    }

    _buildPanelStatusText(displayWindows, prefix, hasError) {
        if (displayWindows.length === 0)
            return hasError ? 'Err' : '--';

        if (displayWindows.length === 1) {
            const w = displayWindows[0];
            const pct = Math.round(w.utilization * 100);
            const resetText = w.resetsAt
                ? ` ↻${this._formatPanelResetTime(w.resetsAt)}`
                : '';
            return `${prefix}: ${pct}%${resetText}`;
        }

        // 'all' mode: compact per-window list, reset suffix dropped to save space.
        const parts = displayWindows.map(w =>
            `${w.shortLabel ?? '?'}:${Math.round(w.utilization * 100)}%`);
        return `${prefix ? prefix + ' ' : ''}${parts.join(' ')}`;
    }

    _createVerticalBar(utilization) {
        const clampedFraction = Math.max(0, Math.min(1, utilization));
        const fillHeight = Math.round(clampedFraction * PANEL_VBAR_HEIGHT);

        const container = new St.Widget({
            style_class: 'panel-vbar-container',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const fill = new St.Widget({
            style_class: `panel-vbar-fill ${this._getUsageColorClass(utilization)}`,
        });
        fill.set_height(fillHeight);
        fill.set_position(0, PANEL_VBAR_HEIGHT - fillHeight);

        container.add_child(fill);
        return container;
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

        const inFlight = this._refreshInFlight;
        const refreshBtn = new St.BoxLayout({
            style_class: 'm3-pill-button m3-pill-button-secondary',
            reactive: !inFlight,
            track_hover: !inFlight,
            x_expand: true,
        });
        refreshBtn.add_child(new St.Label({
            text: inFlight ? '↻ Refreshing…' : '↺ Refresh',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        if (inFlight) {
            refreshBtn.set_opacity(140);
        } else {
            refreshBtn.connect('button-release-event', () => {
                this._refresh();
                this.menu.close();
            });
        }
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

        this._applyMenuTextColor();
    }

    _isLightTheme() {
        // St.SystemColorScheme (GNOME 44+): treat only PREFER_DARK as dark.
        if (typeof St.SystemColorScheme !== 'undefined') {
            const scheme = this._stSettings?.color_scheme;
            if (scheme === St.SystemColorScheme.PREFER_DARK) return false;
            if (scheme === St.SystemColorScheme.PREFER_LIGHT) return true;
        }
        // Fallback: read the Gio.Settings string directly (GNOME 42+).
        try {
            return this._ifaceSettings.get_string('color-scheme') !== 'prefer-dark';
        } catch (_e) {
            return false;
        }
    }

    _applyMenuTextColor() {
        const color = this._isLightTheme() ? '#000000' : '#ffffff';
        this._setLabelColor(this.menu.box, color);
    }

    _setLabelColor(widget, color) {
        if (widget instanceof St.Label) {
            const sc = widget.style_class ?? '';
            if (!sc.includes('m3-error-label') && !sc.includes('m3-warn-label'))
                widget.set_style(`color: ${color};`);
        }
        try {
            for (const child of widget.get_children())
                this._setLabelColor(child, color);
        } catch (_e) { /* widget has no children */ }
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
            const pill = new St.Label({
                style_class: 'm3-provider-pill',
                text: providerClass.displayName,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (providerClass.brandColor)
                pill.set_style(`background-color: ${providerClass.brandColor};`);
            headerRow.add_child(pill);
        }

        const planName = state?.result?.planName;
        if (planName) {
            headerRow.add_child(new St.Label({
                style_class: 'm3-plan-label',
                text: String(planName),
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
        const BAR_WIDTH = MENU_BAR_WIDTH;
        const BAR_HEIGHT = MENU_BAR_HEIGHT;

        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Short label: "5h", "7d", "1°", etc.
        const labelWidget = new St.Label({
            style_class: 'm3-window-label',
            text: window.shortLabel ?? (window.label ? String(window.label).substring(0, 3) : '??'),
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
        barFill.set_width(Math.max(0, Math.min(BAR_WIDTH, Math.round((window.utilization || 0) * BAR_WIDTH))));
        barFill.set_height(BAR_HEIGHT);
        barContainer.add_child(barFill);
        row.add_child(barContainer);

        // Percentage
        const pct = Math.round((window.utilization || 0) * 100);
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
                text: `↻${this._formatPanelResetTime(window.resetsAt)}`,
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

    _formatResetTimeColon(resetDate) {
        try {
            const diffMs = resetDate.getTime() - Date.now();
            if (diffMs <= 0) return 'now';

            const totalMinutes = Math.floor(diffMs / 60000);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            return `${hours}:${String(minutes).padStart(2, '0')}`;
        } catch (e) {
            return '--';
        }
    }

    _formatPanelResetTime(resetDate) {
        const mode = this._settings.get_string('panel-time-display-mode');
        if (mode === PANEL_TIME_DISPLAY_RECOVERY)
            return this._formatRecoveryTime(resetDate);
        if (mode === PANEL_TIME_DISPLAY_REMAINING_COLON)
            return this._formatResetTimeColon(resetDate);

        return this._formatResetTime(resetDate);
    }

    _formatRecoveryTime(resetDate) {
        try {
            if (resetDate.getTime() <= Date.now()) return 'now';

            const hours = String(resetDate.getHours()).padStart(2, '0');
            const minutes = String(resetDate.getMinutes()).padStart(2, '0');
            return `${hours}:${minutes}`;
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
        if (hours < 24) return `${hours}h${minutes % 60}m ago`;
        const days = Math.floor(hours / 24);
        return `${days}d${hours % 24}h ago`;
    }

    // --- Cleanup ---

    destroy() {
        this._destroyed = true;
        this._stopTimer();
        this._stopPanelTimeTimer();

        if (this._debounceTimerId !== null) {
            GLib.source_remove(this._debounceTimerId);
            this._debounceTimerId = null;
        }

        // Cancel any pending inter-account throttle and release the awaiting
        // refresh loop so its promise does not hang.
        if (this._interAccountTimerId !== null) {
            GLib.source_remove(this._interAccountTimerId);
            this._interAccountTimerId = null;
        }
        if (this._interAccountResolve) {
            this._interAccountResolve();
            this._interAccountResolve = null;
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

        if (this._colorSchemeHandlerId) {
            this._stSettings?.disconnect(this._colorSchemeHandlerId);
            this._colorSchemeHandlerId = null;
        }

        if (this._ifaceColorSchemeId) {
            this._ifaceSettings.disconnect(this._ifaceColorSchemeId);
            this._ifaceColorSchemeId = null;
        }
        this._ifaceSettings = null;

        this._accountStates.clear();
        super.destroy();
    }
});


// --- Extension Entry Point ---

export default class CodingAgentRateLimitExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        migrateVisibilitySettings(this._settings);
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
