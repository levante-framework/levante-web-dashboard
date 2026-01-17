#!/bin/bash
# Script to add Vercel MCP server to Cursor configuration

set -e

MCP_CONFIG_FILE="$HOME/.cursor/mcp.json"
BACKUP_FILE="${MCP_CONFIG_FILE}.backup.$(date +%Y%m%d_%H%M%S)"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}Vercel MCP Server Setup for Cursor${NC}"
echo "=================================="
echo ""

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${RED}Error: jq is required but not installed.${NC}"
    echo "Install it with: sudo apt-get install jq"
    exit 1
fi

# Check if MCP config file exists
if [ ! -f "$MCP_CONFIG_FILE" ]; then
    echo -e "${YELLOW}Warning: MCP config file not found at $MCP_CONFIG_FILE${NC}"
    echo "Creating new configuration file..."
    mkdir -p "$(dirname "$MCP_CONFIG_FILE")"
    echo '{"mcpServers": {}}' > "$MCP_CONFIG_FILE"
fi

# Backup original file
echo "Backing up current configuration to: $BACKUP_FILE"
cp "$MCP_CONFIG_FILE" "$BACKUP_FILE"

# Check if Vercel MCP is already configured
if jq -e '.mcpServers.vercel' "$MCP_CONFIG_FILE" > /dev/null 2>&1; then
    echo -e "${YELLOW}Vercel MCP server is already configured.${NC}"
    read -p "Do you want to update it? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# Update the configuration
echo ""
echo "Updating MCP configuration..."

# Use jq to add/update the Vercel MCP server configuration
jq '
  .mcpServers.vercel = {
    "url": "https://mcp.vercel.com"
  }
' "$MCP_CONFIG_FILE" > "${MCP_CONFIG_FILE}.tmp" && mv "${MCP_CONFIG_FILE}.tmp" "$MCP_CONFIG_FILE"

echo -e "${GREEN}✓ Vercel MCP server added successfully!${NC}"
echo ""
echo "Configuration file: $MCP_CONFIG_FILE"
echo "Backup saved to: $BACKUP_FILE"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Restart Cursor for the changes to take effect"
echo "2. After restart, Cursor will prompt you to authenticate with Vercel"
echo "3. Click 'Connect' or 'Needs login' when prompted to sign in with your Vercel account"
echo "4. The Vercel MCP server will be available in all your Cursor projects"
echo ""
echo -e "${BLUE}Available Vercel MCP features:${NC}"
echo "  - Explore Vercel projects"
echo "  - Inspect deployments"
echo "  - Fetch deployment logs"
echo "  - View project settings"
echo "  - Manage environments"
echo "  - And more..."
echo ""
echo -e "${YELLOW}Note:${NC}"
echo "If you see 'Needs authentication' after restarting, click it to complete the OAuth flow."
echo "Make sure your Cursor version is up to date for best compatibility."
