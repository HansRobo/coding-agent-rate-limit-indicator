// Icon cache for provider SVG icons.
// Fetches icons from provider-defined URLs and caches them on disk.
// Icons are never bundled in the extension — they are fetched once and cached.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const CACHE_SUBDIR = 'coding-agent-rate-limit-indicator/icons';

export class IconCache {
    /**
     * @param {Soup.Session} session     - Shared HTTP session for fetching
     * @param {Function}     onIconReady - Called when a new icon becomes available (triggers UI refresh)
     */
    constructor(session, onIconReady) {
        this._session = session;
        this._onIconReady = onIconReady;
        this._destroyed = false;

        // In-flight fetch promises keyed by "{providerId}-{style}"
        this._inFlight = new Map();

        this._ensureCacheDir();
    }

    // --- Public API ---

    /**
     * Get a cached icon synchronously.
     * Returns a Gio.FileIcon if the icon is already on disk, or null.
     * If null, a background fetch is automatically triggered.
     *
     * @param {string} providerId - Provider ID (used for cache filename)
     * @param {string} url        - URL to fetch icon from
     * @param {string} style      - 'monochrome' or 'color' (used for cache filename)
     * @returns {Gio.FileIcon | null}
     */
    getIcon(providerId, url, style) {
        const cachePath = this._getCachePath(providerId, style);

        if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) {
            return new Gio.FileIcon({file: Gio.File.new_for_path(cachePath)});
        }

        // Not cached yet — kick off a background fetch (deduplicated)
        this._fetchIcon(providerId, url, style);
        return null;
    }

    /**
     * Pre-fetch icons for multiple providers.
     * Safe to call multiple times — already-cached icons are skipped.
     *
     * @param {Array<{id: string, getIconUrl: Function}>} providers - Provider classes
     * @param {string} style
     */
    prefetchAll(providers, style) {
        for (const provider of providers) {
            let url;
            try {
                url = provider.getIconUrl(style);
            } catch (e) {
                // Provider has no icon URL — skip silently
                continue;
            }

            const cachePath = this._getCachePath(provider.id, style);
            if (!GLib.file_test(cachePath, GLib.FileTest.EXISTS)) {
                this._fetchIcon(provider.id, url, style);
            }
        }
    }

    destroy() {
        this._destroyed = true;
        this._inFlight.clear();
    }

    // --- Private ---

    _getCacheDir() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), CACHE_SUBDIR]);
    }

    _getCachePath(providerId, style) {
        return GLib.build_filenamev([this._getCacheDir(), `${providerId}-${style}.svg`]);
    }

    _ensureCacheDir() {
        GLib.mkdir_with_parents(this._getCacheDir(), 0o755);
    }

    _fetchIcon(providerId, url, style) {
        const key = `${providerId}-${style}`;

        // Deduplicate concurrent fetches for the same key
        if (this._inFlight.has(key)) return;

        const promise = this._doFetch(providerId, url, style).finally(() => {
            this._inFlight.delete(key);
        });

        this._inFlight.set(key, promise);
    }

    _doFetch(providerId, url, style) {
        return new Promise((resolve) => {
            if (this._destroyed) {
                resolve();
                return;
            }

            const message = Soup.Message.new('GET', url);

            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_LOW,
                null,
                (sess, result) => {
                    if (this._destroyed) {
                        resolve();
                        return;
                    }

                    try {
                        const bytes = sess.send_and_read_finish(result);
                        const statusCode = message.get_status();

                        if (statusCode !== 200) {
                            console.warn(
                                `Icon fetch failed for ${providerId} (HTTP ${statusCode}): ${url}`
                            );
                            resolve();
                            return;
                        }

                        this._saveToCache(providerId, style, bytes);
                        resolve();

                        if (!this._destroyed && this._onIconReady)
                            this._onIconReady();
                    } catch (e) {
                        console.warn(`Icon fetch error for ${providerId}: ${e.message}`);
                        resolve();
                    }
                }
            );
        });
    }

    _saveToCache(providerId, style, bytes) {
        try {
            this._ensureCacheDir();
            const cachePath = this._getCachePath(providerId, style);
            const file = Gio.File.new_for_path(cachePath);

            const decoder = new TextDecoder('utf-8');
            const svgText = this._injectSvgColor(decoder.decode(bytes.get_data()), style);
            const encoder = new TextEncoder();

            file.replace_contents(
                encoder.encode(svgText),
                null,   // etag
                false,  // make_backup
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null    // cancellable
            );
        } catch (e) {
            console.warn(`Failed to cache icon for ${providerId}: ${e.message}`);
        }
    }

    /**
     * Inject a fill color into the root <svg> element if no fill is set.
     * CDN URLs already embed the color; raw SVG files (e.g. JSDelivr) do not.
     */
    _injectSvgColor(svgText, style) {
        if (style !== 'monochrome') return svgText;
        // Only inject if the SVG has no fill on the root element
        if (svgText.includes('fill=')) return svgText;
        return svgText.replace('<svg ', '<svg fill="#ffffff" ');
    }
}
