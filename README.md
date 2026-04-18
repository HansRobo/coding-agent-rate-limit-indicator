# Coding Agent Rate Limit Indicator

A GNOME Shell extension that monitors rate limit usage for multiple coding agent services in the top bar.

![GNOME Shell 45+](https://img.shields.io/badge/GNOME_Shell-45--50-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- **Multi-provider support**: Monitor Claude Code (Anthropic), Codex (OpenAI), Gemini CLI / Antigravity (Google), GLM (z.ai), and more
- **Multi-account**: Configure multiple accounts per provider
- **Top bar indicator**: Concise usage display with text, progress bar, or both; SVG provider icons fetched from CDN and cached locally
- **Detailed popup menu**: Per-account breakdown with progress bars, reset timers, and usage percentages; theme-adaptive colors for light/dark GNOME Shell themes
- **Color-coded usage**: Green → Yellow → Orange → Red as usage increases
- **Extensible architecture**: Clean provider pattern makes it easy to add new services
- **Secure credential storage**: Tokens stored in GNOME Keyring (Secret Service)
- **Auto-detect credentials**: Claude Code, Codex, and Gemini read OAuth tokens from local config automatically
- **Automatic token refresh**: OAuth tokens are refreshed automatically when expired (Claude, Codex, Gemini)
- **Rate limit resilience**: 429 responses trigger per-account backoff using `Retry-After` header
- **Proxy support**: Optional HTTP proxy for all API requests

## Supported Providers

| Provider | Auth Method | API |
|----------|-----------|-----|
| **Claude Code** (Anthropic) | Auto-detect from `~/.claude/.credentials.json` | Anthropic OAuth Usage API |
| **Codex** (OpenAI/ChatGPT) | Auto-detect from `~/.codex/auth.json` | ChatGPT Internal API |
| **Gemini** (Gemini CLI / Antigravity) | Auto-detect from `~/.gemini/oauth_creds.json` | Google Code Assist API |
| **GLM** (z.ai) | Manual API key | z.ai Monitor API |

Notes:
- The Gemini provider uses the Gemini CLI OAuth/Code Assist backend. Antigravity works when it shares that backend state.
- Standalone Antigravity secure-storage extraction is not implemented in this first pass.

### Adding a new provider

The extension uses a clean provider pattern. To add support for a new coding agent:

1. Create a new file in `providers/` extending `BaseProvider`
2. Implement `fetchUsage()` returning normalized `UsageResult` data
3. Register the provider in `providerRegistry.js`

See `providers/base.js` for the interface definition and `providers/claude.js` for a reference implementation.

## Requirements

- GNOME Shell 45 or later (Ubuntu 24.04+, Fedora 40+, etc.)
- `libsoup3` (usually pre-installed)
- `libsecret` / GNOME Keyring (usually pre-installed)

## Installation

### From source

```bash
git clone https://github.com/hans/coding-agent-rate-limit-indicator.git
cd coding-agent-rate-limit-indicator
chmod +x install.sh
./install.sh
```

Then restart GNOME Shell and enable the extension:

```bash
# On X11: Alt+F2 → r → Enter
# On Wayland: log out and back in

gnome-extensions enable coding-agent-rate-limit-indicator@github.com
```

## Configuration

Open the extension preferences via GNOME Extensions app or:

```bash
gnome-extensions prefs coding-agent-rate-limit-indicator@github.com
```

### General Settings

- **Refresh interval**: 60–3600 seconds (default: 300)
- **Display mode**: Text, Progress Bar, or Both
- **HTTP Proxy**: Optional proxy URL for API requests

### Account Setup

#### Claude Code

1. Open extension preferences → Accounts tab
2. Click "Add Claude Code account"
3. Enter a display name (e.g., "Work", "Personal")
4. The extension auto-detects your OAuth token from `~/.claude/.credentials.json`
5. For multiple Claude accounts, specify different credential file paths

#### Codex (OpenAI)

1. Open extension preferences → Accounts tab
2. Click "Add Codex account"
3. Enter a display name
4. The extension auto-detects your OAuth token from `~/.codex/auth.json` (written by the Codex CLI after login)
5. For a custom credential file location, set the `CODEX_HOME` environment variable or specify a path in account settings

#### GLM (z.ai)

1. Open extension preferences → Accounts tab
2. Click "Add GLM account"
3. Enter a display name
4. Enter your z.ai API key in the token field
   - Log in to [z.ai](https://z.ai) and generate an API key from your account settings

#### Gemini (Gemini CLI / Antigravity)

1. Open extension preferences → Accounts tab
2. Click "Add Gemini account"
3. Enter a display name
4. The extension auto-detects your OAuth token from `~/.gemini/oauth_creds.json`
5. If your Gemini account requires a Google Cloud project, set it in the account settings
6. Choose the per-account panel quota strategy:
   - `Most constrained`: show the tightest quota bucket in the panel
   - `Pooled first`: prefer the pooled bucket when available
   - `Pooled only`: show only the pooled bucket in the panel

## Architecture

```
├── extension.js          # Main entry point, panel UI, popup menu, refresh logic
├── prefs.js              # Preferences window (libadwaita)
├── constants.js          # Shared constants
├── accounts.js           # Multi-account CRUD operations
├── secret.js             # GNOME Keyring integration
├── iconCache.js          # Fetches and caches provider SVG icons from CDN
├── providerRegistry.js   # Provider registration and lookup
├── providers/
│   ├── base.js           # Base provider interface
│   ├── claude.js         # Claude Code (Anthropic) provider
│   ├── codex.js          # Codex (OpenAI) provider
│   ├── gemini.js         # Gemini CLI / Antigravity (Google) provider
│   └── glm.js            # GLM (z.ai) provider
├── schemas/              # GSettings schema
├── stylesheet.css        # Extension styles
├── install.sh            # Installation script
└── uninstall.sh          # Uninstallation script
```

### Design Principles

- **Separation of concerns**: Display layer (`extension.js`) is fully decoupled from data fetching (`providers/`)
- **Normalized data model**: All providers return the same `UsageResult` format regardless of API differences
- **Multi-account first**: Every provider supports multiple accounts from day one
- **Graceful degradation**: Shows stale data with a marker when refresh fails, never crashes

## Acknowledgments

Inspired by these excellent GNOME Shell extensions:

- [claude-usage-extension](https://github.com/Haletran/claude-usage-extension) by Haletran
- [ccusage-indicator](https://github.com/lordvcs/ccusage-indicator) by lordvcs
- [codex-usage-indicator](https://github.com/stonega/codex-usage-indicator) by stonega

## License

MIT License. See [LICENSE](LICENSE) for details.

This extension is not affiliated with, funded by, or associated with Anthropic, OpenAI, Google, or Antigravity.
