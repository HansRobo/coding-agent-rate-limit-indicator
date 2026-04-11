// Shared constants for the Coding Agent Rate Limit Indicator extension.

// --- Provider IDs ---
export const PROVIDER_CLAUDE = 'claude';
export const PROVIDER_CODEX = 'codex';
export const PROVIDER_GLM = 'glm';

// --- Claude (Anthropic) ---
export const CLAUDE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_BETA_HEADER = 'oauth-2025-04-20';
export const CLAUDE_TOKEN_ENDPOINT = 'https://api.anthropic.com/v1/oauth/token';
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// --- GLM (z.ai) ---
export const GLM_API_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

// --- Codex (OpenAI / ChatGPT) ---
export const CODEX_API_BASE = 'https://chatgpt.com';
export const CODEX_USAGE_ENDPOINT = '/backend-api/wham/usage';
export const CODEX_ME_ENDPOINT = '/backend-api/me';
export const CODEX_REFERER = 'https://chatgpt.com/codex/settings/usage';
export const CODEX_AUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

// --- Defaults ---
export const DEFAULT_REFRESH_INTERVAL = 300; // seconds
export const MIN_REFRESH_INTERVAL = 60;
export const MAX_REFRESH_INTERVAL = 3600;
export const HTTP_TIMEOUT = 30; // seconds
export const DEFAULT_RETRY_AFTER_SECS = 60;
export const DEFAULT_ERROR_BACKOFF_SECS = 30;
export const SETTINGS_DEBOUNCE_MS = 2000;

// --- Usage window IDs ---
export const WINDOW_FIVE_HOUR = 'five_hour';
export const WINDOW_SEVEN_DAY = 'seven_day';
export const WINDOW_PRIMARY = 'primary';
export const WINDOW_WEEKLY = 'weekly';
export const WINDOW_MONTHLY = 'monthly';

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

// --- UI dimensions ---
export const PANEL_VBAR_HEIGHT = 20;
export const MENU_BAR_WIDTH = 150;
export const MENU_BAR_HEIGHT = 6;

// --- Schema ID ---
export const SCHEMA_ID = 'org.gnome.shell.extensions.coding-agent-rate-limit-indicator';

