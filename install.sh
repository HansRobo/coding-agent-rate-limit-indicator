#!/bin/bash
# Install the Coding Agent Rate Limit Indicator GNOME Shell extension.

set -euo pipefail

EXTENSION_UUID="coding-agent-rate-limit-indicator@github.com"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing $EXTENSION_UUID..."

# Create install directory
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/providers"
mkdir -p "$INSTALL_DIR/schemas"

# Copy extension files
cp "$SOURCE_DIR/metadata.json"       "$INSTALL_DIR/"
cp "$SOURCE_DIR/extension.js"        "$INSTALL_DIR/"
cp "$SOURCE_DIR/prefs.js"            "$INSTALL_DIR/"
cp "$SOURCE_DIR/constants.js"        "$INSTALL_DIR/"
cp "$SOURCE_DIR/accounts.js"         "$INSTALL_DIR/"
cp "$SOURCE_DIR/secret.js"           "$INSTALL_DIR/"
cp "$SOURCE_DIR/providerRegistry.js" "$INSTALL_DIR/"
cp "$SOURCE_DIR/stylesheet.css"      "$INSTALL_DIR/"
cp "$SOURCE_DIR/providers/"*.js      "$INSTALL_DIR/providers/"

# Copy and compile schemas
cp "$SOURCE_DIR/schemas/"*.xml "$INSTALL_DIR/schemas/"
glib-compile-schemas "$INSTALL_DIR/schemas/"

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
