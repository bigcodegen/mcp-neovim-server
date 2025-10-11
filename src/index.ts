#!/usr/bin/env node

/**
 * This is an MCP server that connects to neovim.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NeovimManager, NeovimConnectionError, NeovimCommandError, NeovimValidationError } from "./neovim.js";
import { z } from "zod";

const server = new McpServer(
  {
    name: "mcp-neovim-server",
    version: "0.6.0"
  }
);

const neovimManager = NeovimManager.getInstance();

// Register resources
server.resource(
  "session",
  new ResourceTemplate("nvim://session", { 
    list: () => ({
      resources: [{
        uri: "nvim://session",
        mimeType: "text/plain",
        name: "Current neovim session",
        description: "Current neovim text editor session"
      }]
    })
  }),
  async (uri) => {
    const bufferContents = await neovimManager.getBufferContents();
    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/plain",
        text: Array.from(bufferContents.entries())
          .map(([lineNum, lineText]) => `${lineNum}: ${lineText}`)
          .join('\n')
      }]
    };
  }
);

server.resource(
  "buffers",
  new ResourceTemplate("nvim://buffers", { 
    list: () => ({
      resources: [{
        uri: "nvim://buffers",
        mimeType: "application/json",
        name: "Open Neovim buffers",
        description: "List of all open buffers in the current Neovim session"
      }]
    })
  }),
  async (uri) => {
    const openBuffers = await neovimManager.getOpenBuffers();
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(openBuffers, null, 2)
      }]
    };
  }
);

// Register tools with proper parameter schemas
server.tool(
  "vim_buffer",
  "Read buffer contents with line numbers",
  { filename: z.string().optional().describe("Optional file name to view a specific buffer") },
  async ({ filename }) => {
    const bufferContents = await neovimManager.getBufferContents(filename);
    return {
      content: [{
        type: "text",
        text: Array.from(bufferContents.entries())
          .map(([lineNum, lineText]) => `${lineNum}: ${lineText}`)
          .join('\n')
      }]
    };
  }
);

server.tool(
  "vim_command",
  "Execute Vim commands or shell commands",
  { command: z.string().describe("Vim command to execute (use ! prefix for shell commands if enabled)") },
  async ({ command }) => {
    // Check if this is a shell command
    if (command.startsWith('!')) {
      const allowShellCommands = process.env.ALLOW_SHELL_COMMANDS === 'true';
      if (!allowShellCommands) {
        throw new Error("Shell command execution is disabled. Set ALLOW_SHELL_COMMANDS=true environment variable to enable shell commands.");
      }
    }

    const result = await neovimManager.sendCommand(command);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

server.tool(
  "vim_status",
  "Retrieve Neovim status: cursor position, mode, marks, registers",
  {},
  async () => {
    const status = await neovimManager.getNeovimStatus();
    return {
      content: [{
        type: "text",
        text: JSON.stringify(status, null, 2)
      }]
    };
  }
);

server.tool(
  "vim_edit",
  "Modify buffer content: insert, replace, or replace all",
  {
    startLine: z.number().describe("The line number where editing should begin (1-indexed)"),
    mode: z.enum(["insert", "replace", "replaceAll"]).describe("Whether to insert new content, replace existing content, or replace entire buffer"),
    lines: z.string().describe("The text content to insert or use as replacement")
  },
  async ({ startLine, mode, lines }) => {
    const result = await neovimManager.editLines(startLine, mode, lines);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

server.tool(
  "vim_window",
  "Manage windows: split, close, navigate",
  {
    command: z.enum(["split", "vsplit", "only", "close", "wincmd h", "wincmd j", "wincmd k", "wincmd l"])
      .describe("Window manipulation command: split or vsplit to create new window, only to keep just current window, close to close current window, or wincmd with h/j/k/l to navigate between windows")
  },
  async ({ command }) => {
    const result = await neovimManager.manipulateWindow(command);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

server.tool(
  "vim_mark",
  "Set named mark at position",
  {
    mark: z.string().regex(/^[a-z]$/).describe("Single lowercase letter [a-z] to use as the mark name"),
    line: z.number().describe("The line number where the mark should be placed (1-indexed)"),
    column: z.number().describe("The column number where the mark should be placed (0-indexed)")
  },
  async ({ mark, line, column }) => {
    const result = await neovimManager.setMark(mark, line, column);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

server.tool(
  "vim_register",
  "Set register content",
  {
    register: z.string().regex(/^[a-z"]$/).describe("Register name - a lowercase letter [a-z] or double-quote [\"] for the unnamed register"),
    content: z.string().describe("The text content to store in the specified register")
  },
  async ({ register, content }) => {
    const result = await neovimManager.setRegister(register, content);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

server.tool(
  "vim_visual",
  "Create visual selection",
  {
    startLine: z.number().describe("The starting line number for visual selection (1-indexed)"),
    startColumn: z.number().describe("The starting column number for visual selection (0-indexed)"),
    endLine: z.number().describe("The ending line number for visual selection (1-indexed)"),
    endColumn: z.number().describe("The ending column number for visual selection (0-indexed)")
  },
  async ({ startLine, startColumn, endLine, endColumn }) => {
    const result = await neovimManager.visualSelect(startLine, startColumn, endLine, endColumn);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

// New enhanced buffer management tools
server.tool(
  "vim_buffer_switch",
  "Switch to buffer by number or filename",
  {
    identifier: z.union([z.string(), z.number()]).describe("Buffer identifier - can be buffer number or filename/path")
  },
  async ({ identifier }) => {
    const result = await neovimManager.switchBuffer(identifier);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

server.tool(
  "vim_buffer_save",
  "Save buffer to file",
  {
    filename: z.string().optional().describe("Optional filename to save buffer to (defaults to current buffer's filename)")
  },
  async ({ filename }) => {
    const result = await neovimManager.saveBuffer(filename);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

server.tool(
  "vim_file_open",
  "Open file in buffer",
  {
    filename: z.string().describe("Path to the file to open")
  },
  async ({ filename }) => {
    const result = await neovimManager.openFile(filename);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

// New search and replace tools
server.tool(
  "vim_search",
  "Search buffer with regex and options",
  {
    pattern: z.string().describe("Search pattern (supports regex)"),
    ignoreCase: z.boolean().optional().describe("Whether to ignore case in search (default: false)"),
    wholeWord: z.boolean().optional().describe("Whether to match whole words only (default: false)")
  },
  async ({ pattern, ignoreCase = false, wholeWord = false }) => {
    const result = await neovimManager.searchInBuffer(pattern, { ignoreCase, wholeWord });
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

server.tool(
  "vim_search_replace",
  "Find and replace text with options",
  {
    pattern: z.string().describe("Search pattern (supports regex)"),
    replacement: z.string().describe("Replacement text"),
    global: z.boolean().optional().describe("Replace all occurrences in each line (default: false)"),
    ignoreCase: z.boolean().optional().describe("Whether to ignore case in search (default: false)"),
    confirm: z.boolean().optional().describe("Whether to confirm each replacement (default: false)")
  },
  async ({ pattern, replacement, global = false, ignoreCase = false, confirm = false }) => {
    const result = await neovimManager.searchAndReplace(pattern, replacement, { global, ignoreCase, confirm });
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

server.tool(
  "vim_grep",
  "Search project files with vimgrep",
  {
    pattern: z.string().describe("Search pattern to grep for"),
    filePattern: z.string().optional().describe("File pattern to search in (default: **/* for all files)")
  },
  async ({ pattern, filePattern = "**/*" }) => {
    const result = await neovimManager.grepInProject(pattern, filePattern);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

// Health check tool
server.tool(
  "vim_health",
  "Check connection health",
  {},
  async () => {
    const isHealthy = await neovimManager.healthCheck();
    return {
      content: [{
        type: "text",
        text: isHealthy ? "Neovim connection is healthy" : "Neovim connection failed"
      }]
    };
  }
);

// Macro management tool
server.tool(
  "vim_macro",
  "Record, stop, play macros",
  {
    action: z.enum(["record", "stop", "play"]).describe("Action to perform with macros"),
    register: z.string().optional().describe("Register to record/play macro (a-z, required for record/play)"),
    count: z.number().optional().describe("Number of times to play macro (default: 1)")
  },
  async ({ action, register, count = 1 }) => {
    const result = await neovimManager.manageMacro(action, register, count);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

// Tab management tool
server.tool(
  "vim_tab",
  "Manage tabs: create, close, navigate",
  {
    action: z.enum(["new", "close", "next", "prev", "first", "last", "list"]).describe("Tab action to perform"),
    filename: z.string().optional().describe("Filename for new tab (optional)")
  },
  async ({ action, filename }) => {
    const result = await neovimManager.manageTab(action, filename);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

// Code folding tool
server.tool(
  "vim_fold",
  "Manage folds: create, open, close, toggle",
  {
    action: z.enum(["create", "open", "close", "toggle", "openall", "closeall", "delete"]).describe("Folding action to perform"),
    startLine: z.number().optional().describe("Start line for creating fold (required for create)"),
    endLine: z.number().optional().describe("End line for creating fold (required for create)")
  },
  async ({ action, startLine, endLine }) => {
    const result = await neovimManager.manageFold(action, startLine, endLine);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

// Jump list navigation tool
server.tool(
  "vim_jump",
  "Navigate jump list: back, forward, list",
  {
    direction: z.enum(["back", "forward", "list"]).describe("Jump direction or list jumps")
  },
  async ({ direction }) => {
    const result = await neovimManager.navigateJumpList(direction);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

// LSP Integration Tools
server.tool(
  "vim_lsp_clients",
  "List active LSP clients",
  {},
  async () => {
    const clients = await neovimManager.getLSPClients();
    return {
      content: [{
        type: "text",
        text: JSON.stringify(clients, null, 2)
      }]
    };
  }
);

server.tool(
  "vim_lsp_diagnostics",
  "Get LSP diagnostics for buffer",
  {
    bufferId: z.number().optional().describe("Optional buffer ID to get diagnostics for (defaults to current buffer)")
  },
  async ({ bufferId }) => {
    const diagnostics = await neovimManager.getLSPDiagnostics(bufferId);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(diagnostics, null, 2)
      }]
    };
  }
);

server.tool(
  "vim_lsp_action",
  "Execute LSP actions: hover, definition, references, rename, format, code_action",
  {
    action: z.enum(["hover", "definition", "references", "rename", "format", "code_action"]).describe("LSP action to execute"),
    params: z.object({
      newName: z.string().optional().describe("New name for rename action")
    }).optional().describe("Parameters for the LSP action")
  },
  async ({ action, params }) => {
    const result = await neovimManager.executeLSPAction(action, params);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

// Advanced Search Tool
server.tool(
  "vim_search_structured",
  "Search with positions and capture groups",
  {
    pattern: z.string().describe("Search pattern (supports regex)"),
    ignoreCase: z.boolean().optional().describe("Whether to ignore case in search (default: false)"),
    wholeWord: z.boolean().optional().describe("Whether to match whole words only (default: false)"),
    maxResults: z.number().optional().describe("Maximum number of results to return (default: unlimited)")
  },
  async ({ pattern, ignoreCase = false, wholeWord = false, maxResults }) => {
    const matches = await neovimManager.searchWithMatches(pattern, { ignoreCase, wholeWord, maxResults });
    const formatted = matches.map(match =>
      `Line ${match.line}:${match.column}-${match.endColumn}: ${match.text}${match.groups ? ` (Groups: ${match.groups.join(', ')})` : ''}`
    ).join('\n');

    return {
      content: [{
        type: "text",
        text: `Found ${matches.length} matches:\n${formatted}`
      }]
    };
  }
);



// Performance-optimized tools
server.tool(
  "vim_buffer_optimized",
  "Read buffer with caching",
  { filename: z.string().optional().describe("Optional file name to view a specific buffer") },
  async ({ filename }) => {
    const bufferContents = await neovimManager.getBufferContentsOptimized(filename);
    return {
      content: [{
        type: "text",
        text: Array.from(bufferContents.entries())
          .map(([lineNum, lineText]) => `${lineNum}: ${lineText}`)
          .join('\n')
      }]
    };
  }
);

server.tool(
  "vim_batch_operations",
  "Execute multiple buffer operations",
  {
    operations: z.array(z.object({
      type: z.enum(["edit", "insert", "delete"]).describe("Type of operation"),
      startLine: z.number().describe("Starting line number (1-indexed)"),
      endLine: z.number().optional().describe("Ending line number (1-indexed, for edit/delete)"),
      text: z.string().optional().describe("Text to insert or use for replacement")
    })).describe("Array of operations to perform in batch")
  },
  async ({ operations }) => {
    const result = await neovimManager.batchBufferOperations(operations);
    return {
      content: [{
        type: "text",
        text: result
      }]
    };
  }
);

// Register a sample prompt for Neovim workflow assistance
server.prompt(
  "neovim_workflow", 
  "Get help with common Neovim workflows and editing tasks",
  {
    task: z.enum(["editing", "navigation", "search", "buffers", "windows", "macros"]).describe("Type of Neovim task you need help with")
  },
  async ({ task }) => {
    const workflows = {
      editing: "Here are common editing workflows:\n1. Use vim_edit with 'insert' mode to add new content\n2. Use vim_edit with 'replace' mode to modify existing lines\n3. Use vim_search_replace for find and replace operations\n4. Use vim_visual to select text ranges before operations",
      navigation: "Navigation workflows:\n1. Use vim_mark to set bookmarks in your code\n2. Use vim_jump to navigate through your jump history\n3. Use vim_command with 'gg' or 'G' to go to start/end of file\n4. Use vim_command with line numbers like ':42' to jump to specific lines",
      search: "Search workflows:\n1. Use vim_search to find patterns in current buffer\n2. Use vim_grep for project-wide searches\n3. Use vim_search_replace for complex find/replace operations\n4. Use vim_search_structured for advanced regex matching with positions",
      buffers: "Buffer management:\n1. Use vim_buffer to view buffer contents\n2. Use vim_buffer_switch to change between buffers\n3. Use vim_file_open to open new files\n4. Use vim_buffer_save to save your work",
      windows: "Window management:\n1. Use vim_window with 'split'/'vsplit' to create new windows\n2. Use vim_window with 'wincmd h/j/k/l' to navigate between windows\n3. Use vim_window with 'close' to close current window\n4. Use vim_window with 'only' to keep only current window",
      macros: "Macro workflows:\n1. Use vim_macro with 'record' and a register to start recording\n2. Perform your actions in Neovim\n3. Use vim_macro with 'stop' to end recording\n4. Use vim_macro with 'play' to execute recorded actions"
    };

    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: workflows[task] || "Unknown task type. Available tasks: editing, navigation, search, buffers, windows, macros"
          }
        }
      ]
    };
  }
);

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Setup graceful shutdown handlers
  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}, shutting down gracefully...`);
    try {
      await neovimManager.disconnect();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
