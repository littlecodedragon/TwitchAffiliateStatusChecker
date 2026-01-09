#!/bin/bash
# Uninstall script for Twitch Token Server
# Removes installed files, disables systemd service, and deletes configuration

set -e

SERVICE_NAME="twitch-token-server"
INSTALL_DIR="/opt/twitch-token-server"
CONFIG_FILE="/etc/twitch-token-server.conf"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ "$EUID" -ne 0 ]; then
    echo "Please run as root: sudo ./uninstall.sh"
    exit 1
fi

echo "Stopping and disabling service if present..."
if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service"; then
    systemctl stop "$SERVICE_NAME" || true
    systemctl disable "$SERVICE_NAME" || true
fi

echo "Removing systemd service file..."
if [ -f "$SERVICE_FILE" ]; then
    rm -f "$SERVICE_FILE"
fi

echo "Reloading systemd daemon..."
systemctl daemon-reload

echo "Removing installed files..."
if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
fi

if [ -f "$CONFIG_FILE" ]; then
    rm -f "$CONFIG_FILE"
fi

# If AUR helpers installed the service under /usr/lib/systemd/system/ ensure we check there too
if [ -f "/usr/lib/systemd/system/${SERVICE_NAME}.service" ]; then
    rm -f "/usr/lib/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
fi

# Remove any helper scripts installed under /usr/bin
if [ -f "/usr/bin/twitch-token-server-configure" ]; then
    rm -f "/usr/bin/twitch-token-server-configure"
fi

echo "Uninstallation complete."
echo "If you installed via AUR, consider removing the package with your AUR helper (e.g., 'yay -R twitch-token-server')."
