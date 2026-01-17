#!/bin/bash
# Script to add GitHub MCP server to Cursor configuration

set -e

MCP_CONFIG_FILE="$HOME/.cursor/mcp.json"
BACKUP_FILE="${MCP_CONFIG_FILE}.backup.$(date +%Y%m%d_%H%M%S)"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}GitHub MCP Server Setup for Cursor${NC}"
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

# Check if GitHub MCP is already configured
if jq -e '.mcpServers.github' "$MCP_CONFIG_FILE" > /dev/null 2>&1; then
    echo -e "${YELLOW}GitHub MCP server is already configured.${NC}"
    read -p "Do you want to update it? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# Get GitHub token
if [ -n "$1" ]; then
    GITHUB_TOKEN="$1"
    echo "Using GitHub token from command line argument."
else
    echo ""
    echo "Please provide your GitHub Personal Access Token."
    echo "You can create one at: https://github.com/settings/tokens"
    echo "Required scope: 'repo' (full control of private repositories)"
    echo ""
    read -sp "GitHub Personal Access Token: " GITHUB_TOKEN
    echo ""
    
    if [ -z "$GITHUB_TOKEN" ]; then
        echo -e "${RED}Error: GitHub token is required.${NC}"
        exit 1
    fi
fi

# Update the configuration
echo ""
echo "Updating MCP configuration..."

# Use jq to add/update the GitHub MCP server configuration
jq --arg token "$GITHUB_TOKEN" '
  .mcpServers.github = {
    "type": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "@modelcontextprotocol/server-github"
    ],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": $token
    }
  }
' "$MCP_CONFIG_FILE" > "${MCP_CONFIG_FILE}.tmp" && mv "${MCP_CONFIG_FILE}.tmp" "$MCP_CONFIG_FILE"

echo -e "${GREEN}✓ GitHub MCP server added successfully!${NC}"
echo ""
echo "Configuration file: $MCP_CONFIG_FILE"
echo "Backup saved to: $BACKUP_FILE"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Restart Cursor for the changes to take effect"
echo "2. The GitHub MCP server will be available in all your Cursor projects"
echo ""
echo "To verify, restart Cursor and check if GitHub MCP features are available."
