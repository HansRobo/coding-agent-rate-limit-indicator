#!/bin/bash
# Install the Coding Agent Rate Limit Indicator GNOME Shell extension.
#
# Automatically detects the running GNOME Shell version and installs the
# appropriate build:
#   GNOME 45+  →  dist/gnome45/      (ES module format, direct copy)
#   GNOME <45  →  dist/gnome-legacy/ (Rollup-bundled, legacy GJS format)
#
# The build step runs automatically when the dist/ directory is absent.
# To force a rebuild: rm -rf dist/ && ./install.sh

set -euo pipefail

EXTENSION_UUID="coding-agent-rate-limit-indicator@github.com"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Detect GNOME Shell version ---
GNOME_MAJOR=$(gnome-shell --version 2>/dev/null | grep -oP '\d+' | head -1 || echo "45")

if [ "${GNOME_MAJOR}" -ge 45 ] 2>/dev/null; then
    BUILD_TARGET="gnome45"
else
    BUILD_TARGET="gnome-legacy"
fi

BUILD_DIR="$SOURCE_DIR/dist/$BUILD_TARGET"

echo "Detected GNOME Shell $GNOME_MAJOR → using build target: $BUILD_TARGET"

# --- Build if dist is absent ---
if [ ! -d "$BUILD_DIR" ]; then
    echo "Build not found. Running build step…"
    if ! command -v node &>/dev/null; then
        echo "Error: Node.js is required for the build step but was not found." >&2
        echo "Install Node.js (https://nodejs.org/) and re-run this script." >&2
        exit 1
    fi
    (
        cd "$SOURCE_DIR"
        if [ ! -d node_modules ]; then
            echo "Installing npm dependencies…"
            npm install
        fi
        if [ "$BUILD_TARGET" = "gnome45" ]; then
            npm run build:modern
        else
            npm run build:legacy
        fi
    )
fi

echo "Installing $EXTENSION_UUID from $BUILD_DIR…"

# --- Install from build output ---
# Remove stale JS files from previous installs before copying fresh ones.
rm -f "$INSTALL_DIR"/*.js 2>/dev/null || true
rm -f "$INSTALL_DIR"/providers/*.js 2>/dev/null || true

mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/schemas"
if [ -d "$BUILD_DIR/providers" ]; then
    mkdir -p "$INSTALL_DIR/providers"
fi

# Copy JS files
cp "$BUILD_DIR"/*.js "$INSTALL_DIR/"

# Copy optional files
[ -f "$BUILD_DIR/stylesheet.css" ] && cp "$BUILD_DIR/stylesheet.css" "$INSTALL_DIR/"

# Copy metadata and providers (modern build has providers/, legacy is fully bundled)
cp "$BUILD_DIR/metadata.json" "$INSTALL_DIR/"
if [ -d "$BUILD_DIR/providers" ]; then
    cp "$BUILD_DIR/providers/"*.js "$INSTALL_DIR/providers/"
fi

# Copy and compile schemas
cp "$BUILD_DIR/schemas/"*.xml "$INSTALL_DIR/schemas/"
glib-compile-schemas "$INSTALL_DIR/schemas/"

echo ""
echo "Extension installed to $INSTALL_DIR"
echo ""
echo "To enable the extension:"
echo "  1. Restart GNOME Shell:"
echo "     - On X11: press Alt+F2, type 'r', press Enter"
echo "     - On Wayland: log out and log back in"
echo "  2. Enable the extension:"
echo "     gnome-extensions enable $EXTENSION_UUID"
echo ""
echo "Or use GNOME Extensions app / Extension Manager to enable it."
