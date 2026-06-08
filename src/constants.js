// Shared constants for the Coding Agent Rate Limit Indicator extension.

// --- Defaults ---
export const DEFAULT_REFRESH_INTERVAL = 1800; // 30 minutes
export const MIN_REFRESH_INTERVAL = 900; // 15 minutes
export const MAX_REFRESH_INTERVAL = 86400; // 24 hours
export const HTTP_TIMEOUT = 30; // seconds
export const DEFAULT_RETRY_AFTER_SECS = 600;
export const DEFAULT_ERROR_BACKOFF_SECS = 300;
export const SETTINGS_DEBOUNCE_MS = 2000;

// --- Display modes ---
export const DISPLAY_MODE_TEXT = 'text';
export const DISPLAY_MODE_BAR = 'bar';
export const DISPLAY_MODE_BOTH = 'both';

// --- Panel time display modes ---
export const PANEL_TIME_DISPLAY_REMAINING = 'remaining';
export const PANEL_TIME_DISPLAY_RECOVERY = 'recovery';

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
