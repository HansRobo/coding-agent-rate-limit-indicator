#!/bin/bash
# Uninstall the Coding Agent Rate Limit Indicator GNOME Shell extension.

set -euo pipefail

EXTENSION_UUID="coding-agent-rate-limit-indicator@github.com"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "Disabling extension..."
gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true

echo "Removing $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"

echo "Extension uninstalled."
echo "Restart GNOME Shell to complete removal."
