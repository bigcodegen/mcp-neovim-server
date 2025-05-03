[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/bigcodegen-mcp-neovim-server-badge.png)](https://mseep.ai/app/bigcodegen-mcp-neovim-server)

# Neovim MCP Server

A proof of concept integration between Claude Desktop (or any client) and Neovim using Model Context Protocol (MCP) and the official neovim/node-client JavaScript library. This server leverages Vim's native text editing commands and workflows, which Claude already understands, to create a lightweight code or general purpose AI text assistance layer.

<a href="https://glama.ai/mcp/servers/s0fywdwp87"><img width="380" height="200" src="https://glama.ai/mcp/servers/s0fywdwp87/badge" alt="mcp-neovim-server MCP server" /></a>

## Features

- Connects to your nvim instance if you expose a socket file, for example `--listen /tmp/nvim`, when starting nvim
- Views your current buffers
- Gets cursor location, mode, file name
- Runs vim commands and optionally shell commands through vim
- Can make edits using insert or replacement

## API

### Resources

- `nvim://session`: Current neovim text editor session
- `nvim://buffers`: List of all open buffers in the current Neovim session with metadata including modified status, syntax, and window IDs

### Tools
- **vim_buffer**
  - Current VIM text editor buffer with line numbers shown
  - Input `filename` (string)
  - Filename is ignored, returns a string of numbered lines with the current active buffer content
- **vim_command**
  - Send a command to VIM for navigation, spot editing, and line deletion
  - Input `command` (string)
  - Runs a vim command first passed through `nvim.replaceTermcodes`. Multiple commands will work if separated by newlines
  - On error, `'nvim:errmsg'` contents are returned 
- **vim_status**
  - Get the status of the VIM editor
  - Status contains cursor position, mode, filename, visual selection, window layout, current tab, marks, registers, and working directory
- **vim_edit**
  - Edit lines using insert, replace, or replaceAll in the VIM editor
  - Input `startLine` (number), `mode` (`"insert"` | `"replace"` | `"replaceAll"`), `lines` (string)
  - insert will insert lines at startLine
  - replace will replace lines starting at startLine
  - replaceAll will replace the entire buffer contents
- **vim_window**
  - Manipulate Neovim windows (split, vsplit, close, navigate)
  - Input `command` (string: "split", "vsplit", "only", "close", "wincmd h/j/k/l")
  - Allows window management operations
- **vim_mark**
  - Set a mark at a specific position
  - Input `mark` (string: a-z), `line` (number), `column` (number)
  - Sets named marks at specified positions
- **vim_register**
  - Set content of a register
  - Input `register` (string: a-z or "), `content` (string)
  - Manages register contents
- **vim_visual**
  - Make a visual selection
  - Input `startLine` (number), `startColumn` (number), `endLine` (number), `endColumn` (number)
  - Creates visual mode selections

Using this simple set of tools, Claude can peer into your neovim session to answer questions as well as make edits to the buffer.

## Limitations

- This is a quick proof of concept to experiment with Model Context Protocol. Use at your own risk.
- May not interact well with a custom neovim config!
- Error handling could be better.
- Sometimes Claude doesn't get the vim command input just right.

## Configuration

### Environment Variables

- `ALLOW_SHELL_COMMANDS`: Set to 'true' to enable shell command execution (e.g. `!ls`). Defaults to false for security.
- `NVIM_SOCKET_PATH`: Set to the path of your Neovim socket. Defaults to '/tmp/nvim' if not specified.

## Usage with Claude Desktop
Add this to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "MCP Neovim Server": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-neovim-server"
      ],
      "env": {
        "ALLOW_SHELL_COMMANDS": "true",
        "NVIM_SOCKET_PATH": "/tmp/nvim"
      }
    }
  }
}
```

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
