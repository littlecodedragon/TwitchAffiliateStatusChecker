#!/bin/bash
# Setup script for Twitch Token Server
# This script installs and configures the token server to run as a systemd service

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="twitch-token-server"
INSTALL_DIR="/opt/twitch-token-server"
CONFIG_FILE="/etc/twitch-token-server.conf"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

echo -e "${GREEN}=== Twitch Token Server Setup ===${NC}\n"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js is not installed. Please install Node.js first.${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Node.js found: $(node --version)"

# Prompt for CLIENT_ID and CLIENT_SECRET
echo -e "\n${YELLOW}Please enter your Twitch API credentials:${NC}"
echo "You can get these from https://dev.twitch.tv/console/apps"
echo ""

read -p "Client ID: " CLIENT_ID
read -sp "Client Secret: " CLIENT_SECRET
echo ""

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
    echo -e "${RED}Client ID and Client Secret are required!${NC}"
    exit 1
fi

# Prompt for port
read -p "Port (default: 4000): " PORT
PORT=${PORT:-4000}

echo -e "\n${YELLOW}Installing token server...${NC}"

# Create installation directory
mkdir -p "$INSTALL_DIR"

# Copy server file
cp "$SCRIPT_DIR/token-server.js" "$INSTALL_DIR/"

# Create config file
cat > "$CONFIG_FILE" <<EOF
# Twitch Token Server Configuration
CLIENT_ID=$CLIENT_ID
CLIENT_SECRET=$CLIENT_SECRET
PORT=$PORT
EOF

chmod 600 "$CONFIG_FILE"
echo -e "${GREEN}✓${NC} Configuration saved to $CONFIG_FILE"

# Create systemd service file
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Twitch Token Server
After=network.target

[Service]
Type=simple
EnvironmentFile=$CONFIG_FILE
ExecStart=/usr/bin/node $INSTALL_DIR/token-server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}✓${NC} Systemd service created"

# Reload systemd, enable and start the service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

echo -e "\n${GREEN}=== Installation Complete! ===${NC}\n"
echo -e "The Twitch Token Server is now running and will start automatically on boot."
echo -e "Token endpoint: ${GREEN}http://localhost:$PORT/twitch-token${NC}\n"

echo -e "Useful commands:"
echo -e "  ${YELLOW}sudo systemctl status $SERVICE_NAME${NC}  - Check service status"
echo -e "  ${YELLOW}sudo systemctl stop $SERVICE_NAME${NC}    - Stop the service"
echo -e "  ${YELLOW}sudo systemctl start $SERVICE_NAME${NC}   - Start the service"
echo -e "  ${YELLOW}sudo systemctl restart $SERVICE_NAME${NC} - Restart the service"
echo -e "  ${YELLOW}sudo journalctl -u $SERVICE_NAME -f${NC}  - View logs"
echo -e "  ${YELLOW}sudo nano $CONFIG_FILE${NC}               - Edit configuration"
echo -e ""
echo -e "To reconfigure, edit $CONFIG_FILE and run: ${YELLOW}sudo systemctl restart $SERVICE_NAME${NC}"
