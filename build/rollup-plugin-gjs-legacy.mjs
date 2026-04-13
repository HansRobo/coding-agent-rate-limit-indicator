/**
 * Rollup plugin that transforms ES module output to legacy GJS module format
 * for GNOME Shell 42-44 compatibility.
 *
 * Transformations applied in renderChunk (after Rollup has bundled internals):
 *  - gi://X imports       → const X = imports.gi.X;
 *  - resource:// imports  → const X = imports.ui.Y;  (or deleted for Extension base)
 *  - entry class          → var X = class X { ... } + legacy wrapper functions
 *  - API compat patches   → Adw.AlertDialog→MessageDialog, atob polyfill, etc.
 */

const PREAMBLE = `\
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

`;

const EXTENSION_WRAPPER = `
// Legacy GJS entry point wrapper (GNOME 42-44)
let _instance;
function init() {}
function enable() {
    _instance = new CodingAgentRateLimitExtension();
    _instance.getSettings = function() { return ExtensionUtils.getSettings(); };
    Object.defineProperty(_instance, 'path', { get() { return Me.path; } });
    Object.defineProperty(_instance, 'uuid', { get() { return Me.metadata.uuid; } });
    _instance.openPreferences = function() { ExtensionUtils.openPrefs(); };
    _instance.enable();
}
function disable() {
    if (_instance) {
        _instance.disable();
        _instance = null;
    }
}
`;

const PREFS_WRAPPER = `
// Legacy GJS entry point wrapper (GNOME 42-44)
function init() {}
function fillPreferencesWindow(window) {
    const _prefs = new RateLimitPreferences();
    _prefs.getSettings = function() { return ExtensionUtils.getSettings(); };
    _prefs.fillPreferencesWindow(window);
}
`;

export default function gjsLegacy() {
    return {
        name: 'gjs-legacy',

        // Mark gi:// and resource:// as external so Rollup keeps them as import statements.
        // We transform those statements in renderChunk after bundling.
        resolveId(source) {
            if (source.startsWith('gi://') || source.startsWith('resource:///')) {
                return { id: source, external: true };
            }
            return null;
        },

        renderChunk(code, chunk) {
            let out = code;

            // --- 1. Transform GI imports ---

            // import X from 'gi://Mod?version=V';  →  imports.gi.versions.Mod = 'V';\nconst X = imports.gi.Mod;
            out = out.replace(
                /^import\s+(\w+)\s+from\s+'gi:\/\/(\w+)\?version=([\d.]+)';\n/gm,
                (_m, name, mod, ver) =>
                    `imports.gi.versions.${mod} = '${ver}';\nconst ${name} = imports.gi.${mod};\n`,
            );

            // import X from 'gi://Mod';  →  const X = imports.gi.Mod;
            out = out.replace(
                /^import\s+(\w+)\s+from\s+'gi:\/\/(\w+)';\n/gm,
                (_m, name, mod) => `const ${name} = imports.gi.${mod};\n`,
            );

            // prefs.js bundles provider code (via providerRegistry) which imports Soup,
            // but prefs never exercises HTTP paths.  On GNOME 42 only Soup 2.x is
            // available, so loading Soup 3.0 at file-load time would crash.  Strip
            // the Soup import from the prefs bundle entirely — the Soup-dependent
            // code paths (fetchUsage etc.) are never called from preferences.
            if (chunk.fileName.includes('prefs')) {
                out = out.replace(/^imports\.gi\.versions\.Soup\s*=\s*'[\d.]+';\n/gm, '');
                out = out.replace(/^const Soup\s*=\s*imports\.gi\.Soup;\n/gm, '');
            }

            // --- 2. Transform resource:// namespace imports ---
            // import * as X from 'resource:///org/gnome/shell/ui/mod.js';  →  const X = imports.ui.mod;
            out = out.replace(
                /^import\s+\*\s+as\s+(\w+)\s+from\s+'resource:\/\/\/org\/gnome\/shell\/ui\/(\w+)\.js';\n/gm,
                (_m, name, mod) => `const ${name} = imports.ui.${mod};\n`,
            );

            // --- 3. Remove Extension / ExtensionPreferences framework imports ---
            out = out.replace(
                /^import\s+\{[^}]+\}\s+from\s+'resource:\/\/\/[^']*extensions[^']*';\n/gm,
                '',
            );

            // --- 4. Transform the entry-point class declaration ---
            // Rollup may keep 'export default class X extends Foo {' or hoist to 'class X extends Foo {'
            // We strip 'extends Extension' / 'extends ExtensionPreferences' and remove the export.

            out = out.replace(
                /^export\s+default\s+class\s+(\w+)\s+extends\s+(?:Extension|ExtensionPreferences)\s*\{/m,
                'var $1 = class $1 {',
            );
            out = out.replace(
                /^class\s+(\w+)\s+extends\s+(?:Extension|ExtensionPreferences)\s*\{/m,
                'var $1 = class $1 {',
            );

            // --- 5. Remove the trailing export statement ---
            // 'export { X as default };'  or  'export default X;'
            out = out.replace(/^export\s+\{\s*\w+\s+as\s+default\s*\};\n?/m, '');
            out = out.replace(/^export\s+default\s+\w+;\n?/m, '');

            // --- 6. API compatibility patches ---

            // Soup.Message.get_status() — polyfill for Soup 2.x (GNOME 42)
            // GNOME Shell 42 pre-loads Soup 2.4 into the process, so the extension's
            // version=3.0 request is silently ignored. Soup 2.x exposes .status_code
            // instead of get_status(). Inject a prototype polyfill so the source code's
            // get_status() calls work on both Soup 2.x and 3.x.
            out = out.replace(
                /(const Soup = imports\.gi\.Soup;\n)/,
                '$1' +
                'if (typeof Soup.Message.prototype.get_status !== \'function\') {\n' +
                '    Soup.Message.prototype.get_status = function() { return this.status_code; };\n' +
                '}\n',
            );

            // Adw.AlertDialog (libadwaita 1.5 / GNOME 46) → Adw.MessageDialog (1.2 / GNOME 43)
            out = out.replace(/\bAdw\.AlertDialog\b/g, 'Adw.MessageDialog');
            // MessageDialog requires set_transient_for; inject before present()
            out = out.replace(
                /\bdialog\.present\(\s*window\s*\)/g,
                'dialog.set_transient_for(window); dialog.present()',
            );

            // Adw.SpinRow (libadwaita 1.4 / GNOME 45) → Adw.ActionRow + Gtk.SpinButton
            // SpinRow is unavailable in libadwaita < 1.4 (GNOME 42-44).
            // Step A: Replace the SpinRow constructor.
            //   Captures: (newline+indent), (varName), (title), (subtitle), (Gtk.Adjustment block)
            const spinRowVars = new Set();
            out = out.replace(
                /(\n\s*)const\s+(\w+)\s*=\s*new\s+Adw\.SpinRow\(\{\s*\n\s*title:\s*('[^']*'|"[^"]*")\s*,\s*\n\s*subtitle:\s*('[^']*'|"[^"]*")\s*,\s*\n\s*adjustment:\s*(new\s+Gtk\.Adjustment\(\{[\s\S]*?\}\))\s*,?\s*\n\s*\}\)/g,
                (_, nl, varName, title, subtitle, adj) => {
                    spinRowVars.add(varName);
                    return (
                        `${nl}const ${varName}_adj = ${adj};` +
                        `${nl}const ${varName}_spin = new Gtk.SpinButton({ adjustment: ${varName}_adj, valign: Gtk.Align.CENTER });` +
                        `${nl}const ${varName} = new Adw.ActionRow({ title: ${title}, subtitle: ${subtitle} });` +
                        `${nl}${varName}.add_suffix(${varName}_spin);` +
                        `${nl}${varName}.set_activatable_widget(${varName}_spin)`
                    );
                },
            );
            // Step B: Fix settings.bind targets — bind the SpinButton's value, not the ActionRow.
            for (const varName of spinRowVars) {
                out = out.replace(
                    new RegExp(`settings\\.bind\\(([^,]+),\\s*${varName}\\s*,\\s*'value'`, 'g'),
                    (_, key) => `settings.bind(${key}, ${varName}_spin, 'value'`,
                );
            }

            // Adw.ExpanderRow.add_suffix, Adw.EntryRow, Adw.PasswordEntryRow
            // (libadwaita 1.2-1.4 / GNOME 43-45), Adw.MessageDialog (1.2 / GNOME 43)
            // — inject constructor polyfills for GNOME 42 (libadwaita 1.1)
            if (chunk.fileName.includes('prefs')) {
                const PREFS_POLYFILLS = `
// --- Polyfills for libadwaita < 1.4 (GNOME 42-44) ---
// ExpanderRow.add_suffix (1.4) → add_action (1.0, deprecated in 1.4)
if (typeof Adw.ExpanderRow.prototype.add_suffix !== 'function') {
    Adw.ExpanderRow.prototype.add_suffix = Adw.ExpanderRow.prototype.add_action;
}
// Shared factory for EntryRow / PasswordEntryRow polyfills.
// Wraps a Gtk editable widget inside an ActionRow, proxying the
// set_text/get_text API and mapping the 'apply' signal to 'activate'.
function _makeEntryRow(entry, props) {
    const row = new Adw.ActionRow({ title: (props && props.title) || '' });
    row.add_suffix(entry);
    row.set_activatable_widget(entry);
    row.set_text = (t) => entry.set_text(t);
    row.get_text = () => entry.get_text();
    const _connect = row.connect.bind(row);
    row.connect = (sig, ...a) => sig === 'apply'
        ? entry.connect('activate', ...a) : _connect(sig, ...a);
    return row;
}
if (typeof Adw.EntryRow === 'undefined') {
    Adw.EntryRow = function(props) {
        return _makeEntryRow(new Gtk.Entry({ valign: Gtk.Align.CENTER, hexpand: true }), props);
    };
}
if (typeof Adw.PasswordEntryRow === 'undefined') {
    Adw.PasswordEntryRow = function(props) {
        return _makeEntryRow(new Gtk.PasswordEntry({ valign: Gtk.Align.CENTER, hexpand: true, show_peek_icon: true }), props);
    };
}
if (typeof Adw.MessageDialog === 'undefined') {
    if (typeof Adw.ResponseAppearance === 'undefined')
        Adw.ResponseAppearance = { SUGGESTED: 0, DESTRUCTIVE: 1 };
    Adw.MessageDialog = function(props) {
        const dlg = new Gtk.Dialog({ title: (props && props.heading) || '', modal: true, use_header_bar: 1 });
        if (props && props.body) {
            const lbl = new Gtk.Label({ label: props.body, wrap: true,
                margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12 });
            dlg.get_content_area().append(lbl);
        }
        const _responses = [];
        dlg.add_response = (id, label) => { dlg.add_button(label, _responses.length); _responses.push(id); };
        dlg.set_response_appearance = () => {};
        dlg.set_extra_child = (child) => dlg.get_content_area().append(child);
        const _connect = dlg.connect.bind(dlg);
        dlg.connect = (sig, ...a) => {
            if (sig === 'response') {
                const cb = a[0];
                return _connect('response', (_d, idx) => { cb(_d, _responses[idx] || 'cancel'); _d.close(); });
            }
            return _connect(sig, ...a);
        };
        return dlg;
    };
}
`;
                out = out.replace(
                    /(const Gtk = imports\.gi\.Gtk;\n)/,
                    '$1' + PREFS_POLYFILLS,
                );
            }

            // atob() (GJS 1.76 / GNOME 44) — inject polyfill for GNOME 43
            // Placed right after the GLib import so GLib.base64_decode is available.
            if (!chunk.fileName.includes('prefs')) {
                out = out.replace(
                    /(const GLib = imports\.gi\.GLib;\n)/,
                    '$1var atob = globalThis.atob ||\n' +
                    '    function(s) { return new TextDecoder().decode(GLib.base64_decode(s)); };\n',
                );
            }

            // --- 7. Assemble final output ---
            const isPrefs = chunk.fileName.includes('prefs');
            const wrapper = isPrefs ? PREFS_WRAPPER : EXTENSION_WRAPPER;

            return PREAMBLE + out.trimEnd() + '\n' + wrapper;
        },
    };
}
