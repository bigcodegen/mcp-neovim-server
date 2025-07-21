#!/usr/bin/env zsh
# Claude wrapper that adds Neovim MCP server when inside Neovim

# Run claude normally if $NVIM is not set
if [[ -z "$NVIM" ]]; then
  command claude "$@"
  return
fi

# If $NVIM is set, create a temporary MCP config
local tmp_config=$(mktemp /tmp/claude-mcp."${NVIM:t}".XXX.json)

# Write the MCP config with the Neovim server
cat >"$tmp_config" <<EOF
{
"mcpServers": {
  "nvim": {
    "command": "npx",
    "args": [
      "-y",
      "mcp-neovim-server"
    ],
    "env": {
      "ALLOW_SHELL_COMMANDS": "true",
      "NVIM_SOCKET_PATH": "$NVIM"
    }
  }
}
}
EOF

# Run claude with the custom config
command claude --mcp-config "$tmp_config" "$@"
local exit_code=$?

# Clean up
rm -f "$tmp_config"

return $exit_code
