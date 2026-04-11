// Preferences UI for Coding Agent Rate Limit Indicator.
// Uses libadwaita (Adw) widgets for GNOME 45+ settings.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    MIN_REFRESH_INTERVAL,
    MAX_REFRESH_INTERVAL,
    DISPLAY_MODE_TEXT,
    DISPLAY_MODE_BAR,
    DISPLAY_MODE_BOTH,
} from './constants.js';

import {
    loadAccounts,
    loadVisibleIds,
    addAccount,
    updateAccount,
    removeAccount,
    setAccountVisibility,
} from './accounts.js';

import {storeToken, clearToken} from './secret.js';

import {
    getProviderList,
} from './providerRegistry.js';


export default class RateLimitPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Track signal connections for cleanup
        const signalIds = [];

        // --- General page ---
        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);
        this._buildGeneralPage(generalPage, settings);

        // --- Accounts page ---
        const accountsPage = new Adw.PreferencesPage({
            title: 'Accounts',
            icon_name: 'system-users-symbolic',
        });
        window.add(accountsPage);
        this._buildAccountsPage(accountsPage, settings, window, signalIds);

        // --- About page ---
        const aboutPage = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });
        window.add(aboutPage);
        this._buildAboutPage(aboutPage);

        // Disconnect signals when window is destroyed
        window.connect('destroy', () => {
            for (const id of signalIds) {
                try {
                    settings.disconnect(id);
                } catch (e) {
                    // ignore
                }
            }
            signalIds.length = 0;
        });
    }

    // === General Page ===

    _buildGeneralPage(page, settings) {
        // Refresh group
        const refreshGroup = new Adw.PreferencesGroup({
            title: 'Refresh',
            description: 'How often to fetch usage data from providers.',
        });
        page.add(refreshGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between updates',
            adjustment: new Gtk.Adjustment({
                lower: MIN_REFRESH_INTERVAL,
                upper: MAX_REFRESH_INTERVAL,
                step_increment: 30,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        refreshGroup.add(intervalRow);

        // Display group
        const displayGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'How usage data appears in the top bar.',
        });
        page.add(displayGroup);

        // Display mode
        const displayModeRow = new Adw.ComboRow({
            title: 'Display mode',
            subtitle: 'What to show in the panel',
            model: Gtk.StringList.new(['Text', 'Progress Bar', 'Both']),
        });
        const modeMap = [DISPLAY_MODE_TEXT, DISPLAY_MODE_BAR, DISPLAY_MODE_BOTH];
        const currentMode = settings.get_string('display-mode');
        displayModeRow.set_selected(Math.max(0, modeMap.indexOf(currentMode)));
        displayModeRow.connect('notify::selected', () => {
            settings.set_string('display-mode', modeMap[displayModeRow.get_selected()]);
        });
        displayGroup.add(displayModeRow);

        // Network group
        const networkGroup = new Adw.PreferencesGroup({
            title: 'Network',
        });
        page.add(networkGroup);

        const proxyRow = new Adw.EntryRow({
            title: 'HTTP Proxy URL',
            show_apply_button: true,
        });
        proxyRow.set_text(settings.get_string('proxy-url'));
        proxyRow.connect('apply', () => {
            settings.set_string('proxy-url', proxyRow.get_text());
        });
        networkGroup.add(proxyRow);
    }

    // === Accounts Page ===

    _buildAccountsPage(page, settings, window, signalIds) {
        const accountsGroup = new Adw.PreferencesGroup({
            title: 'Configured Accounts',
            description: 'Add accounts for each coding agent service you use.',
        });
        page.add(accountsGroup);

        // Track rows for reliable cleanup
        this._accountRows = [];

        // Render current accounts
        this._renderAccountRows(accountsGroup, settings, window);

        // Listen for changes to rebuild
        const sigId = settings.connect('changed::accounts-json', () => {
            this._removeAccountRows(accountsGroup);
            this._renderAccountRows(accountsGroup, settings, window);
        });
        signalIds.push(sigId);

        // Add account button group
        const addGroup = new Adw.PreferencesGroup();
        page.add(addGroup);

        const providers = getProviderList();
        for (const provider of providers) {
            const addRow = new Adw.ActionRow({
                title: `Add ${provider.displayName} account`,
                subtitle: provider.requiresManualToken
                    ? `Requires manual ${provider.tokenFieldLabel.toLowerCase()}`
                    : 'Auto-detects credentials from local config',
                activatable: true,
            });
            addRow.add_suffix(new Gtk.Image({
                icon_name: 'list-add-symbolic',
                valign: Gtk.Align.CENTER,
            }));
            addRow.connect('activated', () => {
                this._showAddAccountDialog(window, settings, provider);
            });
            addGroup.add(addRow);
        }
    }

    _renderAccountRows(group, settings, window) {
        const accounts = loadAccounts(settings);
        const visibleIds = new Set(loadVisibleIds(settings));
        this._accountRows = [];

        if (accounts.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: 'No accounts configured',
                subtitle: 'Use the buttons below to add an account',
            });
            group.add(emptyRow);
            this._accountRows.push(emptyRow);
            return;
        }

        const providers = getProviderList();
        const providerMap = new Map(providers.map(p => [p.id, p]));

        for (const account of accounts) {
            const provider = providerMap.get(account.provider);
            const providerName = provider ? provider.displayName : account.provider;

            const expander = new Adw.ExpanderRow({
                title: account.name || providerName,
                subtitle: providerName,
            });

            // Visibility toggle
            const visibleSwitch = new Gtk.Switch({
                active: visibleIds.size === 0 || visibleIds.has(account.id),
                valign: Gtk.Align.CENTER,
            });
            visibleSwitch.connect('notify::active', () => {
                setAccountVisibility(settings, account.id, visibleSwitch.get_active());
            });
            expander.add_suffix(visibleSwitch);

            // Account name edit
            const nameRow = new Adw.EntryRow({
                title: 'Display name',
                show_apply_button: true,
            });
            nameRow.set_text(account.name);
            nameRow.connect('apply', () => {
                updateAccount(settings, account.id, {name: nameRow.get_text()});
            });
            expander.add_row(nameRow);

            // Provider-specific config fields
            if (provider) {
                for (const field of provider.configFields) {
                    const configRow = new Adw.EntryRow({
                        title: field.label,
                        show_apply_button: true,
                    });
                    configRow.set_text(account.config?.[field.key] ?? '');
                    configRow.connect('apply', () => {
                        updateAccount(settings, account.id, {
                            config: {[field.key]: configRow.get_text()},
                        });
                    });
                    expander.add_row(configRow);
                }
            }

            // Token entry (for providers that need manual token)
            if (!provider || provider.requiresManualToken) {
                const tokenRow = new Adw.PasswordEntryRow({
                    title: provider ? provider.tokenFieldLabel : 'Bearer token',
                    show_apply_button: true,
                });
                tokenRow.connect('apply', () => {
                    const token = tokenRow.get_text().trim();
                    if (token) {
                        storeToken(account.id, token);
                    }
                });
                expander.add_row(tokenRow);
            }

            // Token entry for auto-detect providers (optional override)
            if (provider && !provider.requiresManualToken) {
                const tokenRow = new Adw.PasswordEntryRow({
                    title: 'Token override (optional)',
                    show_apply_button: true,
                });
                tokenRow.connect('apply', () => {
                    const token = tokenRow.get_text().trim();
                    if (token) {
                        storeToken(account.id, token);
                    }
                });
                expander.add_row(tokenRow);
            }

            // Remove button
            const removeRow = new Adw.ActionRow({
                title: 'Remove this account',
                activatable: true,
            });
            removeRow.add_suffix(new Gtk.Image({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
            }));
            removeRow.add_css_class('error');
            removeRow.connect('activated', () => {
                this._confirmRemoveAccount(window, settings, account);
            });
            expander.add_row(removeRow);

            group.add(expander);
            this._accountRows.push(expander);
        }
    }

    _removeAccountRows(group) {
        for (const row of this._accountRows) {
            try {
                group.remove(row);
            } catch (e) {
                // ignore
            }
        }
        this._accountRows = [];
    }

    _showAddAccountDialog(window, settings, provider) {
        const bodyText = provider.requiresManualToken
            ? `Enter a display name and your ${provider.tokenFieldLabel.toLowerCase()}.`
            : 'Enter a display name for this account.';

        const dialog = new Adw.AlertDialog({
            heading: `Add ${provider.displayName} Account`,
            body: bodyText,
            close_response: 'cancel',
        });

        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('add', 'Add');
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_start: 12,
            margin_end: 12,
        });

        const nameEntry = new Gtk.Entry({
            placeholder_text: 'e.g., Work, Personal',
        });
        box.append(nameEntry);

        let tokenEntry = null;
        if (provider.requiresManualToken) {
            tokenEntry = new Gtk.PasswordEntry({
                placeholder_text: provider.tokenFieldLabel,
                show_peek_icon: true,
            });
            box.append(tokenEntry);
        }

        dialog.set_extra_child(box);

        dialog.connect('response', (_dialog, response) => {
            if (response === 'add') {
                const name = nameEntry.get_text().trim() || provider.displayName;
                const account = addAccount(settings, provider.id, name, provider.defaultConfig);
                if (tokenEntry) {
                    const token = tokenEntry.get_text().trim();
                    if (token)
                        storeToken(account.id, token);
                }
            }
        });

        dialog.present(window);
    }

    _confirmRemoveAccount(window, settings, account) {
        const dialog = new Adw.AlertDialog({
            heading: 'Remove Account?',
            body: `Remove "${account.name}"? This will also delete the stored token.`,
            close_response: 'cancel',
        });

        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('remove', 'Remove');
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);

        dialog.connect('response', (_dialog, response) => {
            if (response === 'remove') {
                clearToken(account.id);
                removeAccount(settings, account.id);
            }
        });

        dialog.present(window);
    }

    // === About Page ===

    _buildAboutPage(page) {
        const aboutGroup = new Adw.PreferencesGroup();
        page.add(aboutGroup);

        const titleRow = new Adw.ActionRow({
            title: 'Coding Agent Rate Limit Indicator',
            subtitle: 'Monitor rate limits for coding agents in the GNOME top bar.',
        });
        aboutGroup.add(titleRow);

        const versionRow = new Adw.ActionRow({
            title: 'Version',
            subtitle: '1.0.0',
        });
        aboutGroup.add(versionRow);

        const linksGroup = new Adw.PreferencesGroup({
            title: 'Links',
        });
        page.add(linksGroup);

        const ghRow = new Adw.ActionRow({
            title: 'Source Code',
            subtitle: 'github.com/hans/coding-agent-rate-limit-indicator',
            activatable: true,
        });
        ghRow.add_suffix(new Gtk.Image({
            icon_name: 'web-browser-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        ghRow.connect('activated', () => {
            Gio.AppInfo.launch_default_for_uri(
                'https://github.com/hans/coding-agent-rate-limit-indicator',
                null
            );
        });
        linksGroup.add(ghRow);

        // Supported providers
        const providersGroup = new Adw.PreferencesGroup({
            title: 'Supported Providers',
        });
        page.add(providersGroup);

        const providers = getProviderList();
        for (const provider of providers) {
            const row = new Adw.ActionRow({
                title: provider.displayName,
                subtitle: `Auth: ${
                    provider.requiresManualToken ? 'Manual token' : 'Auto-detect'
                }`,
            });
            providersGroup.add(row);
        }
    }
}
