# CLAUDE.md - Coding Agent Rate Limit Indicator

## Project Overview

A GNOME Shell extension that monitors rate limit usage for multiple coding agent services (Claude Code, Codex, Gemini, etc.) in the top bar. Uses a provider pattern for extensibility.

## Language Policy

- **All repository content** (code, comments, commit messages, PRs, README, CLAUDE.md) must be in **English**
- User communication (conversation) is in Japanese

## Architecture

- **Provider pattern**: Each service (Claude, Codex) has a provider in `src/providers/` implementing `BaseProvider`
- **Normalized data model**: All providers return `{ windows: [{id, label, used, limit, utilization, resetsAt}], planName }`
- **Display layer** (`extension.js`) consumes normalized data — never touches API details
- **Account management** (`accounts.js`) stores multi-account config as JSON in GSettings
- **Secret storage** (`secret.js`) uses GNOME Keyring for tokens

## Key Files

Source lives in `src/`:

- `src/extension.js` — Panel indicator, popup menu, refresh orchestration
- `src/prefs.js` — Preferences UI (libadwaita)
- `src/iconCache.js` — Fetches and caches provider SVG icons from provider-defined URLs
- `src/providers/base.js` — Base provider interface
- `src/providers/claude.js` — Anthropic OAuth API provider
- `src/providers/codex.js` — ChatGPT internal API provider
- `src/providerRegistry.js` — Provider registration/lookup
- `src/accounts.js` — Account CRUD
- `src/secret.js` — GNOME Keyring wrapper
- `src/constants.js` — Shared constants

Build infrastructure:

- `build/build.mjs` — Build orchestrator (modern copy + legacy Rollup bundle)
- `build/rollup-plugin-gjs-legacy.mjs` — Custom Rollup plugin: transforms `gi://` imports, entry-point
  class wrappers, API compat patches (Adw.AlertDialog→MessageDialog, atob polyfill, etc.)

## Development

### Build and install for development
```bash
npm install          # first time only
npm run build        # produces dist/gnome45/ and dist/gnome-legacy/
./install.sh         # auto-detects GNOME version, always rebuilds, then installs
```

### Enable/disable
```bash
gnome-extensions enable coding-agent-rate-limit-indicator@github.com
gnome-extensions disable coding-agent-rate-limit-indicator@github.com
```

### View logs
```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

### Compile schemas (done by install.sh)
```bash
glib-compile-schemas src/schemas/
```

## Build Targets

| Target | Directory | Shell versions | Format |
|--------|-----------|----------------|--------|
| modern | `dist/gnome45/` | 45–50 | ES modules (source copy) |
| legacy | `dist/gnome-legacy/` | 42–44 | Rollup-bundled single files, legacy GJS |

The legacy build bundles all modules into `extension.js` and `prefs.js` — no `providers/` directory.

## Conventions

- GNOME Shell 45+ ES module syntax (`import ... from 'gi://...'`) in `src/`
- GObject.registerClass for all Shell widgets
- Async operations via GLib/Gio callbacks wrapped in Promises
- No external dependencies beyond GNOME platform libraries
- GSettings for preferences, GNOME Keyring for secrets

## Adding a New Provider

1. Create `src/providers/<name>.js` extending `BaseProvider`
2. Implement static properties: `id`, `displayName`
3. Implement `static getIconUrl(style)` → URL string for 'monochrome' and 'color' styles. Icons are fetched at runtime and cached in `~/.cache/coding-agent-rate-limit-indicator/icons/`. Optionally override `static get shortLabel()` for a 2-char text fallback (default: initials of displayName).
4. Implement `fetchUsage(account, session, getToken)` → `UsageResult`
5. Register in `src/providerRegistry.js`: `registerProvider(NewProvider)`
6. Add constants to `src/constants.js` if needed
