# CLAUDE.md - Coding Agent Rate Limit Indicator

## Project Overview

A GNOME Shell extension that monitors rate limit usage for multiple coding agent services (Claude Code, Codex, Gemini, etc.) in the top bar. Uses a provider pattern for extensibility.

## Language Policy

- **All repository content** (code, comments, commit messages, PRs, README, CLAUDE.md) must be in **English**
- User communication (conversation) is in Japanese

## Architecture

- **Provider pattern**: Each service (Claude, Codex) has a provider in `providers/` implementing `BaseProvider`
- **Normalized data model**: All providers return `{ windows: [{id, label, used, limit, utilization, resetsAt}], planName }`
- **Display layer** (`extension.js`) consumes normalized data — never touches API details
- **Account management** (`accounts.js`) stores multi-account config as JSON in GSettings
- **Secret storage** (`secret.js`) uses GNOME Keyring for tokens

## Key Files

- `extension.js` — Panel indicator, popup menu, refresh orchestration
- `prefs.js` — Preferences UI (libadwaita)
- `iconCache.js` — Fetches and caches provider SVG icons from provider-defined URLs
- `providers/base.js` — Base provider interface
- `providers/claude.js` — Anthropic OAuth API provider
- `providers/codex.js` — ChatGPT internal API provider
- `providerRegistry.js` — Provider registration/lookup
- `accounts.js` — Account CRUD
- `secret.js` — GNOME Keyring wrapper
- `constants.js` — Shared constants

## Development

### Install for development
```bash
./install.sh
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
glib-compile-schemas schemas/
```

## Conventions

- GNOME Shell 45+ ES module syntax (`import ... from 'gi://...'`)
- GObject.registerClass for all Shell widgets
- Async operations via GLib/Gio callbacks wrapped in Promises
- No external dependencies beyond GNOME platform libraries
- GSettings for preferences, GNOME Keyring for secrets

## Adding a New Provider

1. Create `providers/<name>.js` extending `BaseProvider`
2. Implement static properties: `id`, `displayName`
3. Implement `static getIconUrl(style)` → URL string for 'monochrome' and 'color' styles. Icons are fetched at runtime and cached in `~/.cache/coding-agent-rate-limit-indicator/icons/`. Optionally override `static get shortLabel()` for a 2-char text fallback (default: initials of displayName).
4. Implement `fetchUsage(account, session, getToken)` → `UsageResult`
5. Register in `providerRegistry.js`: `registerProvider(NewProvider)`
6. Add constants to `constants.js` if needed
