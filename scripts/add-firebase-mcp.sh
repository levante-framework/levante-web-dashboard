#!/bin/bash
# Script to add Firebase MCP server to Cursor configuration

set -e

MCP_CONFIG_FILE="$HOME/.cursor/mcp.json"
BACKUP_FILE="${MCP_CONFIG_FILE}.backup.$(date +%Y%m%d_%H%M%S)"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}Firebase MCP Server Setup for Cursor${NC}"
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

# Check if Firebase MCP is already configured
if jq -e '.mcpServers.firebase' "$MCP_CONFIG_FILE" > /dev/null 2>&1; then
    echo -e "${YELLOW}Firebase MCP server is already configured.${NC}"
    read -p "Do you want to update it? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# Check if firebase-tools is available
if ! command -v firebase &> /dev/null && ! command -v npx &> /dev/null; then
    echo -e "${YELLOW}Warning: firebase-tools not found locally.${NC}"
    echo "The script will use npx to run firebase-tools@latest, which will download it on first use."
    echo ""
fi

# Check Firebase authentication
echo -e "${BLUE}Checking Firebase authentication...${NC}"
if command -v firebase &> /dev/null; then
    if firebase projects:list &> /dev/null 2>&1; then
        echo -e "${GREEN}✓ Firebase is already authenticated${NC}"
    else
        echo -e "${YELLOW}Firebase authentication required.${NC}"
        echo "You'll need to run: firebase login --no-localhost"
        echo "Or: firebase login (for localhost)"
        echo ""
        read -p "Do you want to authenticate now? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            firebase login --no-localhost || firebase login
        else
            echo -e "${YELLOW}You can authenticate later with: firebase login --no-localhost${NC}"
        fi
    fi
else
    echo -e "${YELLOW}firebase-tools not installed locally.${NC}"
    echo "Authentication will be handled when you first use the MCP server."
    echo "You may need to run: npx firebase-tools login --no-localhost"
fi

# Update the configuration
echo ""
echo "Updating MCP configuration..."

# Use jq to add/update the Firebase MCP server configuration
jq '
  .mcpServers.firebase = {
    "type": "stdio",
    "command": "npx",
    "args": [
      "-y",
      "firebase-tools@latest",
      "mcp"
    ]
  }
' "$MCP_CONFIG_FILE" > "${MCP_CONFIG_FILE}.tmp" && mv "${MCP_CONFIG_FILE}.tmp" "$MCP_CONFIG_FILE"

echo -e "${GREEN}✓ Firebase MCP server added successfully!${NC}"
echo ""
echo "Configuration file: $MCP_CONFIG_FILE"
echo "Backup saved to: $BACKUP_FILE"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Restart Cursor for the changes to take effect"
echo "2. The Firebase MCP server will be available in all your Cursor projects"
echo ""
echo -e "${BLUE}Firebase Authentication:${NC}"
echo "If not already authenticated, run one of these commands:"
echo "  - firebase login --no-localhost  (for remote/headless environments)"
echo "  - firebase login                 (for localhost environments)"
echo ""
echo "To verify, restart Cursor and check if Firebase MCP features are available."
echo ""
echo -e "${BLUE}Available Firebase MCP features:${NC}"
echo "  - Firebase project management"
echo "  - Firestore read/write operations"
echo "  - Firebase Authentication user management"
echo "  - Security rules inspection"
echo "  - Cloud Messaging"
echo "  - And more..."
