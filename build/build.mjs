/**
 * Build orchestrator for the GNOME Shell extension.
 *
 * Produces two distribution targets:
 *  dist/gnome45/       — GNOME 45+ (ESM source files, direct copy)
 *  dist/gnome-legacy/  — GNOME 42-44 (Rollup-bundled, legacy GJS format)
 *
 * Usage:
 *   node build/build.mjs                    # both targets
 *   node build/build.mjs --target modern    # gnome45 only
 *   node build/build.mjs --target legacy    # gnome-legacy only
 */

import { rollup } from 'rollup';
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import gjsLegacy from './rollup-plugin-gjs-legacy.mjs';

const ROOT_DIR  = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR   = join(ROOT_DIR, 'src');
const DIST_DIR  = join(ROOT_DIR, 'dist');

const args    = process.argv.slice(2);
const tIdx    = args.indexOf('--target');
const targets = tIdx !== -1
    ? [args[tIdx + 1]]
    : ['modern', 'legacy'];

// Clean dist/
await rm(DIST_DIR, { recursive: true, force: true });
await mkdir(DIST_DIR, { recursive: true });

if (targets.includes('modern')) {
    await buildModern();
}
if (targets.includes('legacy')) {
    await buildLegacy();
}

// ---------------------------------------------------------------------------

async function buildModern() {
    console.log('Building GNOME 45+ (modern ESM)…');
    const out = join(DIST_DIR, 'gnome45');

    await mkdir(join(out, 'providers'), { recursive: true });
    await mkdir(join(out, 'schemas'),   { recursive: true });

    const rootJs = [
        'extension.js', 'prefs.js', 'constants.js',
        'accounts.js', 'secret.js', 'iconCache.js', 'providerRegistry.js',
    ];
    for (const f of rootJs) {
        await cp(join(SRC_DIR, f), join(out, f));
    }

    const providerJs = ['base.js', 'claude.js', 'codex.js', 'glm.js'];
    for (const f of providerJs) {
        await cp(join(SRC_DIR, 'providers', f), join(out, 'providers', f));
    }

    await cp(join(SRC_DIR, 'stylesheet.css'), join(out, 'stylesheet.css'));
    await cp(join(SRC_DIR, 'metadata.json'),  join(out, 'metadata.json'));
    await cp(join(SRC_DIR, 'schemas'),         join(out, 'schemas'), { recursive: true });

    console.log('  → dist/gnome45/');
}

// ---------------------------------------------------------------------------

async function buildLegacy() {
    console.log('Building GNOME 42-44 (legacy GJS)…');
    const out = join(DIST_DIR, 'gnome-legacy');

    await mkdir(join(out, 'schemas'), { recursive: true });

    const plugin = gjsLegacy();

    for (const entry of ['extension.js', 'prefs.js']) {
        console.log(`  Bundling ${entry}…`);
        const bundle = await rollup({
            input: join(SRC_DIR, entry),
            plugins: [plugin],
            external: id => id.startsWith('gi://') || id.startsWith('resource:///'),
            // Suppress circular-dependency warnings that may arise from GObject patterns
            onwarn(warning, warn) {
                if (warning.code === 'CIRCULAR_DEPENDENCY') return;
                warn(warning);
            },
        });

        await bundle.write({
            file: join(out, entry),
            format: 'es',
        });

        await bundle.close();
    }

    // Static assets
    await cp(join(SRC_DIR, 'stylesheet.css'), join(out, 'stylesheet.css'));
    await cp(join(SRC_DIR, 'schemas'),         join(out, 'schemas'), { recursive: true });

    // Patch metadata.json to declare legacy shell support
    const meta = JSON.parse(await readFile(join(SRC_DIR, 'metadata.json'), 'utf8'));
    const legacyVersions = ['42', '43', '44'];
    const existingVersions = meta['shell-version'] ?? [];
    meta['shell-version'] = [
        ...legacyVersions.filter(v => !existingVersions.includes(v)),
        ...existingVersions,
    ];
    await writeFile(join(out, 'metadata.json'), JSON.stringify(meta, null, 4) + '\n');

    console.log('  → dist/gnome-legacy/');
}
