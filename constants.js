// Shared constants for the Coding Agent Rate Limit Indicator extension.

// --- Provider IDs ---
export const PROVIDER_CLAUDE = 'claude';
export const PROVIDER_CODEX = 'codex';

// --- Claude (Anthropic) ---
export const CLAUDE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_BETA_HEADER = 'oauth-2025-04-20';


// --- Codex (OpenAI / ChatGPT) ---
export const CODEX_API_BASE = 'https://chatgpt.com';
export const CODEX_USAGE_ENDPOINT = '/backend-api/wham/usage';
export const CODEX_ME_ENDPOINT = '/backend-api/me';
export const CODEX_REFERER = 'https://chatgpt.com/codex/settings/usage';

// --- Defaults ---
export const DEFAULT_REFRESH_INTERVAL = 300; // seconds
export const MIN_REFRESH_INTERVAL = 60;
export const MAX_REFRESH_INTERVAL = 3600;
export const HTTP_TIMEOUT = 30; // seconds

// --- Usage window IDs ---
export const WINDOW_FIVE_HOUR = 'five_hour';
export const WINDOW_SEVEN_DAY = 'seven_day';
export const WINDOW_PRIMARY = 'primary';
export const WINDOW_WEEKLY = 'weekly';

// --- Display modes ---
export const DISPLAY_MODE_TEXT = 'text';
export const DISPLAY_MODE_BAR = 'bar';
export const DISPLAY_MODE_BOTH = 'both';

// --- Usage thresholds for color coding ---
export const THRESHOLD_LOW = 0.4;
export const THRESHOLD_MEDIUM = 0.7;
export const THRESHOLD_HIGH = 0.9;

// --- Icons ---
export const PANEL_ICON_SIZE = 16;

// --- Schema ID ---
export const SCHEMA_ID = 'org.gnome.shell.extensions.coding-agent-rate-limit-indicator';

