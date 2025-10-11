import { attach, Neovim } from 'neovim';

export class NeovimAPIError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context?: any
  ) {
    super(message);
    this.name = 'NeovimAPIError';
  }
}

export class NeovimConnectionError extends NeovimAPIError {
  constructor(socketPath: string, cause?: Error) {
    super('CONNECTION_ERROR', `Failed to connect to Neovim at ${socketPath}. Is Neovim running with --listen ${socketPath}?`, { socketPath, cause });
  }
}

export class NeovimCommandError extends NeovimAPIError {
  constructor(command: string, originalError: string) {
    super('COMMAND_ERROR', `Failed to execute command '${command}': ${originalError}`, { command, originalError });
  }
}

export class NeovimValidationError extends NeovimAPIError {
  constructor(message: string, field?: string) {
    super('VALIDATION_ERROR', message, { field });
  }
}

export class BufferNotFoundError extends NeovimAPIError {
  constructor(bufferId: number | string) {
    super('BUFFER_NOT_FOUND', `Buffer ${bufferId} not found`, { bufferId });
  }
}

export class WindowNotFoundError extends NeovimAPIError {
  constructor(windowId: number) {
    super('WINDOW_NOT_FOUND', `Window ${windowId} not found`, { windowId });
  }
}

interface NeovimStatus {
  cursorPosition: [number, number];
  mode: string;
  visualSelection: string;
  fileName: string;
  windowLayout: string;
  currentTab: number;
  marks: { [key: string]: [number, number] };
  registers: { [key: string]: string };
  cwd: string;
  lspInfo?: string;
  pluginInfo?: string;
  visualInfo?: {
    hasActiveSelection: boolean;
    visualModeType?: string;
    startPos?: [number, number];
    endPos?: [number, number];
    lastVisualStart?: [number, number];
    lastVisualEnd?: [number, number];
  };
}

interface BufferInfo {
  number: number;
  name: string;
  isListed: boolean;
  isLoaded: boolean;
  modified: boolean;
  syntax: string;
  windowIds: number[];
}

interface WindowInfo {
  id: number;
  bufferId: number;
  width: number;
  height: number;
  row: number;
  col: number;
}

interface BufferChangeEvent {
  bufferId: number;
  tick: number;
  changes: Array<{
    line: number;
    added: number;
    removed: number;
    text: string[];
  }>;
}

interface CursorMoveEvent {
  bufferId: number;
  line: number;
  column: number;
}

interface LSPClientInfo {
  id: number;
  name: string;
  capabilities: any;
  attachedBuffers: number[];
}

interface EventSubscription {
  id: string;
  event: string;
  callback: (data: any) => void;
}

export class NeovimManager {
  private static instance: NeovimManager;
  private nvim?: Neovim;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private connectionPromise?: Promise<Neovim>;
  private eventSubscriptions: Map<string, EventSubscription> = new Map();
  private eventListenersAttached = false;
  
  // Performance optimization: caching
  private bufferCache: Map<number, { lines: string[]; timestamp: number }> = new Map();
  private windowCache: Map<number, WindowInfo> = new Map();
  private cacheTimeout = 5000; // 5 seconds
  private lastBufferId?: number;

  private constructor() { }

  public static getInstance(): NeovimManager {
    if (!NeovimManager.instance) {
      NeovimManager.instance = new NeovimManager();
    }
    return NeovimManager.instance;
  }

  private async ensureConnected(): Promise<Neovim> {
    if (this.connectionState === 'connected' && this.nvim) {
      return this.nvim;
    }
    
    if (this.connectionState === 'connecting' && this.connectionPromise) {
      return this.connectionPromise;
    }
    
    return this.reconnect();
  }

  private async reconnect(): Promise<Neovim> {
    this.connectionState = 'connecting';
    this.connectionPromise = this.connect();
    
    try {
      this.nvim = await this.connectionPromise;
      this.connectionState = 'connected';
      await this.attachEventListeners();
      return this.nvim;
    } catch (error) {
      this.connectionState = 'disconnected';
      this.connectionPromise = undefined;
      throw error;
    }
  }

  private async attachEventListeners(): Promise<void> {
    if (!this.nvim || this.eventListenersAttached) {
      return;
    }

    try {
      // Buffer change events
      this.nvim.on('buflines', (event: any) => {
        this.emitEvent('buffer_change', {
          bufferId: event.buffer,
          tick: event.tick,
          changes: event.changes
        });
      });

      // Cursor movement events
      this.nvim.on('cursor_moved', (event: any) => {
        this.emitEvent('cursor_move', {
          bufferId: event.buffer,
          line: event.line,
          column: event.column
        });
      });

      // Mode change events
      this.nvim.on('mode_changed', (event: any) => {
        this.emitEvent('mode_change', {
          mode: event.mode,
          oldMode: event.oldMode
        });
      });

      // Buffer enter/leave events
      this.nvim.on('bufenter', (event: any) => {
        this.emitEvent('buffer_enter', {
          bufferId: event.buffer
        });
      });

      this.nvim.on('bufleave', (event: any) => {
        this.emitEvent('buffer_leave', {
          bufferId: event.buffer
        });
      });

      this.eventListenersAttached = true;
    } catch (error) {
      console.error('Failed to attach event listeners:', error);
    }
  }

  private emitEvent(eventType: string, data: any): void {
    for (const [id, subscription] of this.eventSubscriptions) {
      if (subscription.event === eventType) {
        try {
          subscription.callback(data);
        } catch (error) {
          console.error(`Error in event subscription ${id}:`, error);
        }
      }
    }
  }

  public subscribeToEvent(eventType: string, callback: (data: any) => void): string {
    const id = Math.random().toString(36).substr(2, 9);
    this.eventSubscriptions.set(id, {
      id,
      event: eventType,
      callback
    });
    return id;
  }

  public unsubscribeFromEvent(subscriptionId: string): boolean {
    return this.eventSubscriptions.delete(subscriptionId);
  }

  public getActiveSubscriptions(): Array<{ id: string; event: string }> {
    return Array.from(this.eventSubscriptions.values()).map(sub => ({
      id: sub.id,
      event: sub.event
    }));
  }

  // Performance optimization methods
  private isCacheValid(timestamp: number): boolean {
    return Date.now() - timestamp < this.cacheTimeout;
  }

  private clearCache(): void {
    this.bufferCache.clear();
    this.windowCache.clear();
  }

  // Optimized buffer operations with caching
  public async getBufferContentsOptimized(filename?: string): Promise<Map<number, string>> {
    try {
      const nvim = await this.ensureConnected();
      let buffer;

      if (filename) {
        const buffers = await nvim.buffers;
        let targetBuffer = null;

        for (const buf of buffers) {
          const bufName = await buf.name;
          if (bufName === filename || bufName.endsWith(filename)) {
            targetBuffer = buf;
            break;
          }
        }

        if (!targetBuffer) {
          throw new BufferNotFoundError(filename);
        }
        buffer = targetBuffer;
      } else {
        buffer = await nvim.buffer;
      }

      // Check cache first
      const cached = this.bufferCache.get(buffer.id);
      if (cached && this.isCacheValid(cached.timestamp)) {
        const lineMap = new Map<number, string>();
        cached.lines.forEach((line: string, index: number) => {
          lineMap.set(index + 1, line);
        });
        return lineMap;
      }

      // Get fresh data and cache it
      const lines = await buffer.getLines({ start: 0, end: -1, strictIndexing: false });
      this.bufferCache.set(buffer.id, {
        lines,
        timestamp: Date.now()
      });

      const lineMap = new Map<number, string>();
      lines.forEach((line: string, index: number) => {
        lineMap.set(index + 1, line);
      });

      this.lastBufferId = buffer.id;
      return lineMap;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error getting buffer contents:', error);
      throw new NeovimAPIError('BUFFER_CONTENTS_ERROR', 'Failed to get buffer contents', { filename, error });
    }
  }

  // Batch operations for better performance
  public async batchBufferOperations(operations: Array<{
    type: 'edit' | 'insert' | 'delete';
    startLine: number;
    endLine?: number;
    text?: string;
  }>): Promise<string> {
    if (operations.length === 0) {
      return 'No operations to perform';
    }

    try {
      const nvim = await this.ensureConnected();
      const buffer = await nvim.buffer;

      // Clear cache since we're modifying the buffer
      if (this.lastBufferId) {
        this.bufferCache.delete(this.lastBufferId);
      }

      // Sort operations by line number to avoid conflicts
      operations.sort((a, b) => a.startLine - b.startLine);

      for (const op of operations) {
        switch (op.type) {
          case 'edit':
            if (op.text !== undefined) {
              const lines = op.text.split('\n');
              await buffer.setLines(lines, {
                start: op.startLine - 1,
                end: op.endLine ? op.endLine : op.startLine
              });
            }
            break;

          case 'insert':
            if (op.text !== undefined) {
              const lines = op.text.split('\n');
              await buffer.setLines(lines, {
                start: op.startLine - 1,
                end: op.startLine - 1
              });
            }
            break;

          case 'delete':
            await buffer.setLines([], {
              start: op.startLine - 1,
              end: op.endLine ? op.endLine : op.startLine
            });
            break;
        }
      }

      return `Completed ${operations.length} buffer operations`;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error in batch buffer operations:', error);
      throw new NeovimAPIError('BATCH_OPERATION_ERROR', 'Failed to perform batch operations', { operations, error });
    }
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const nvim = await this.ensureConnected();
      await nvim.eval('1'); // Simple test
      return true;
    } catch {
      this.connectionState = 'disconnected';
      this.nvim = undefined;
      return false;
    }
  }

  public async disconnect(): Promise<void> {
    try {
      // Clear all event subscriptions
      this.eventSubscriptions.clear();
      this.eventListenersAttached = false;

      // Clear caches
      this.clearCache();

      // Clear the connection (we don't quit Neovim as it's an external instance)
      if (this.nvim) {
        this.nvim = undefined;
      }

      this.connectionState = 'disconnected';
      this.connectionPromise = undefined;
    } catch (error) {
      console.error('Error during disconnect:', error);
      throw new NeovimAPIError('DISCONNECT_ERROR', 'Failed to disconnect from Neovim', { error });
    }
  }

  private validateSocketPath(path: string): void {
    if (!path || path.trim().length === 0) {
      throw new NeovimValidationError('Socket path cannot be empty');
    }
  }

  private async connect(): Promise<Neovim> {
    const socketPath = process.env.NVIM_SOCKET_PATH || '/tmp/nvim';
    this.validateSocketPath(socketPath);
    
    try {
      return attach({
        socket: socketPath
      });
    } catch (error) {
      console.error('Error connecting to Neovim:', error);
      throw new NeovimConnectionError(socketPath, error as Error);
    }
  }

  public async getBufferContents(filename?: string): Promise<Map<number, string>> {
    try {
      const nvim = await this.ensureConnected();
      let buffer;
      
      if (filename) {
        // Find buffer by filename
        const buffers = await nvim.buffers;
        let targetBuffer = null;
        
        for (const buf of buffers) {
          const bufName = await buf.name;
          if (bufName === filename || bufName.endsWith(filename)) {
            targetBuffer = buf;
            break;
          }
        }
        
        if (!targetBuffer) {
          throw new BufferNotFoundError(filename);
        }
        buffer = targetBuffer;
      } else {
        buffer = await nvim.buffer;
      }
      
      // Use direct API instead of buffer.lines
      const lines = await buffer.getLines({ start: 0, end: -1, strictIndexing: false });
      const lineMap = new Map<number, string>();

      lines.forEach((line: string, index: number) => {
        lineMap.set(index + 1, line);
      });

      return lineMap;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error getting buffer contents:', error);
      throw new NeovimAPIError('BUFFER_CONTENTS_ERROR', 'Failed to get buffer contents', { filename, error });
    }
  }

  public async sendCommand(command: string): Promise<string> {
    if (!command || command.trim().length === 0) {
      throw new NeovimValidationError('Command cannot be empty', 'command');
    }

    try {
      const nvim = await this.ensureConnected();

      // Remove leading colon if present
      const normalizedCommand = command.startsWith(':') ? command.substring(1) : command;

      // Handle shell commands (starting with !)
      if (normalizedCommand.startsWith('!')) {
        if (process.env.ALLOW_SHELL_COMMANDS !== 'true') {
          return 'Shell command execution is disabled. Set ALLOW_SHELL_COMMANDS=true environment variable to enable shell commands.';
        }

        const shellCommand = normalizedCommand.substring(1).trim();
        if (!shellCommand) {
          throw new NeovimValidationError('Shell command cannot be empty', 'shellCommand');
        }
        
        try {
          // Execute the command and capture output directly
          const output = await nvim.eval(`system('${shellCommand.replace(/'/g, "''")}')`);
          if (output) {
            return String(output).trim();
          }
          return 'No output from command';
        } catch (error) {
          console.error('Shell command error:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          throw new NeovimCommandError(`!${shellCommand}`, errorMessage);
        }
      }

      // For regular Vim commands
      await nvim.setVvar('errmsg', '');
      
      // Execute the command and capture its output using the execute() function
      const output = await nvim.call('execute', [normalizedCommand]);
      
      // Check for errors
      const vimerr = await nvim.getVvar('errmsg');
      if (vimerr) {
        console.error('Vim error:', vimerr);
        throw new NeovimCommandError(normalizedCommand, String(vimerr));
      }

      // Return the actual command output if any
      return output ? String(output).trim() : 'Command executed (no output)';
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error sending command:', error);
      throw new NeovimCommandError(command, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private async getVisualSelectionInfo(nvim: Neovim, mode: string): Promise<{
    hasSelection: boolean;
    selectedText?: string;
    startPos?: [number, number];
    endPos?: [number, number];
    visualModeType?: string;
    lastVisualStart?: [number, number];
    lastVisualEnd?: [number, number];
  }> {
    try {
      const isInVisualMode = mode.includes('v') || mode.includes('V') || mode.includes('\x16');

      if (isInVisualMode) {
        // Currently in visual mode - get active selection
        const [startPos, endPos, initialVisualModeType] = await Promise.all([
          nvim.call('getpos', ['v']) as Promise<[number, number, number, number]>,
          nvim.call('getpos', ['.']) as Promise<[number, number, number, number]>,
          nvim.call('visualmode', []) as Promise<string>
        ]);

        // Convert positions to [line, col] format
        const start: [number, number] = [startPos[1], startPos[2]];
        const end: [number, number] = [endPos[1], endPos[2]];

        // Get the selected text using a more reliable approach
        let selectedText = '';
        let visualModeType = initialVisualModeType;
        try {
          const result = await nvim.lua(`
            -- Get visual mode type first
            local mode = vim.fn.visualmode()
            if not mode or mode == '' then
              return { text = '', mode = '' }
            end

            local start_pos = vim.fn.getpos('v')
            local end_pos = vim.fn.getpos('.')
            local start_line, start_col = start_pos[2], start_pos[3]
            local end_line, end_col = end_pos[2], end_pos[3]

            -- Ensure proper ordering (start should be before end)
            if start_line > end_line or (start_line == end_line and start_col > end_col) then
              start_line, end_line = end_line, start_line
              start_col, end_col = end_col, start_col
            end

            local text = ''

            if mode == 'v' then
              -- Character-wise visual mode
              if start_line == end_line then
                local line = vim.api.nvim_buf_get_lines(0, start_line - 1, start_line, false)[1] or ''
                text = line:sub(start_col, end_col)
              else
                local lines = vim.api.nvim_buf_get_lines(0, start_line - 1, end_line, false)
                if #lines > 0 then
                  -- Handle first line
                  lines[1] = lines[1]:sub(start_col)
                  -- Handle last line
                  if #lines > 1 then
                    lines[#lines] = lines[#lines]:sub(1, end_col)
                  end
                  text = table.concat(lines, '\\n')
                end
              end
            elseif mode == 'V' then
              -- Line-wise visual mode
              local lines = vim.api.nvim_buf_get_lines(0, start_line - 1, end_line, false)
              text = table.concat(lines, '\\n')
            elseif mode == '\\022' then
              -- Block-wise visual mode (Ctrl-V)
              local lines = vim.api.nvim_buf_get_lines(0, start_line - 1, end_line, false)
              local result = {}
              for _, line in ipairs(lines) do
                table.insert(result, line:sub(start_col, end_col))
              end
              text = table.concat(result, '\\n')
            end

            return { text = text, mode = mode }
          `) as { text: string; mode: string };

          selectedText = result.text || '';
          visualModeType = result.mode || visualModeType;
        } catch (e) {
          selectedText = '[Selection text unavailable]';
        }

        return {
          hasSelection: true,
          selectedText,
          startPos: start,
          endPos: end,
          visualModeType
        };
      } else {
        // Not in visual mode - get last visual selection marks
        try {
          const [lastStart, lastEnd] = await Promise.all([
            nvim.call('getpos', ["'<"]) as Promise<[number, number, number, number]>,
            nvim.call('getpos', ["'>"]) as Promise<[number, number, number, number]>
          ]);

          return {
            hasSelection: false,
            lastVisualStart: [lastStart[1], lastStart[2]],
            lastVisualEnd: [lastEnd[1], lastEnd[2]]
          };
        } catch (e) {
          return { hasSelection: false };
        }
      }
    } catch (error) {
      return { hasSelection: false, selectedText: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }

  public async getNeovimStatus(): Promise<NeovimStatus | string> {
    try {
      const nvim = await this.ensureConnected();
      const window = await nvim.window;
      const cursor = await window.cursor;
      const mode = await nvim.mode;
      const buffer = await nvim.buffer;
      
      // Get window layout
      const layout = await nvim.eval('winlayout()');
      const tabpage = await nvim.tabpage;
      const currentTab = await tabpage.number;

      // Get marks (a-z) - only include set marks using direct buffer API
      const marks: { [key: string]: [number, number] } = {};
      for (const mark of 'abcdefghijklmnopqrstuvwxyz') {
        try {
          const pos = await buffer.mark(mark);
          // Only include marks that are actually set (not at position 0,0)
          if (pos[0] > 0 && pos[1] > 0) {
            marks[mark] = pos;
          }
        } catch (e) {
          // Mark not set
        }
      }

      // Get registers (a-z, ", 0-9) - only include non-empty registers using callFunction
      const registers: { [key: string]: string } = {};
      const registerNames = [...'abcdefghijklmnopqrstuvwxyz', '"', ...Array.from(Array(10).keys()).map(String)];
      for (const reg of registerNames) {
        try {
          const content = String(await nvim.callFunction('getreg', [String(reg)]));
          // Only include registers that have content
          if (content && content.trim().length > 0) {
            registers[String(reg)] = content;
          }
        } catch (e) {
          // Register empty or error
        }
      }

      // Get current working directory
      const cwd = await nvim.call('getcwd');

      // Get basic plugin information (LSP clients, loaded plugins)
      let lspInfo = '';
      let pluginInfo = '';
      
      try {
        // Get LSP clients if available (use new API for Neovim >=0.10)
        const lspClients = await nvim.eval('luaeval("vim.lsp.get_clients()")');
        if (Array.isArray(lspClients) && lspClients.length > 0) {
          const clientNames = lspClients.map((client: any) => client.name || 'unknown').join(', ');
          lspInfo = `Active LSP clients: ${clientNames}`;
        } else {
          lspInfo = 'No active LSP clients';
        }
      } catch (e) {
        lspInfo = 'LSP information unavailable';
      }

      try {
        // Get loaded plugins (simplified check)
        const hasLsp = await nvim.eval('exists(":LspInfo")');
        const hasTelescope = await nvim.eval('exists(":Telescope")');
        const hasTreesitter = await nvim.eval('exists("g:loaded_nvim_treesitter")');
        const hasCompletion = await nvim.eval('exists("g:loaded_completion")');
        
        const plugins = [];
        if (hasLsp) plugins.push('LSP');
        if (hasTelescope) plugins.push('Telescope');
        if (hasTreesitter) plugins.push('TreeSitter');
        if (hasCompletion) plugins.push('Completion');
        
        pluginInfo = plugins.length > 0 ? `Detected plugins: ${plugins.join(', ')}` : 'No common plugins detected';
      } catch (e) {
        pluginInfo = 'Plugin information unavailable';
      }

      // Get visual selection information using the new method
      const visualInfo = await this.getVisualSelectionInfo(nvim, mode.mode);

      const neovimStatus: NeovimStatus = {
        cursorPosition: cursor,
        mode: mode.mode,
        visualSelection: visualInfo.selectedText || '',
        fileName: await buffer.name,
        windowLayout: JSON.stringify(layout),
        currentTab,
        marks,
        registers,
        cwd,
        lspInfo,
        pluginInfo,
        visualInfo: {
          hasActiveSelection: visualInfo.hasSelection,
          visualModeType: visualInfo.visualModeType,
          startPos: visualInfo.startPos,
          endPos: visualInfo.endPos,
          lastVisualStart: visualInfo.lastVisualStart,
          lastVisualEnd: visualInfo.lastVisualEnd
        }
      };

      return neovimStatus;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error getting Neovim status:', error);
      throw new NeovimAPIError('STATUS_ERROR', 'Failed to get Neovim status', { error });
    }
  }

  public async editLines(startLine: number, mode: 'replace' | 'insert' | 'replaceAll', newText: string): Promise<string> {
    if (startLine < 1) {
      throw new NeovimValidationError('Start line must be >= 1', 'startLine');
    }
    if (!['replace', 'insert', 'replaceAll'].includes(mode)) {
      throw new NeovimValidationError('Invalid mode. Must be replace, insert, or replaceAll', 'mode');
    }

    try {
      const nvim = await this.ensureConnected();
      const splitByLines = newText.split('\n');
      const buffer = await nvim.buffer;

      if (mode === 'replaceAll') {
        // Handle full buffer replacement
        const lineCount = await buffer.length;
        // Delete all lines and then append new content
        await buffer.remove(0, lineCount, true);
        await buffer.insert(splitByLines, 0);
        return 'Buffer completely replaced';
      } else if (mode === 'replace') {
        await buffer.replace(splitByLines, startLine - 1);
        return 'Lines replaced successfully';
      } else if (mode === 'insert') {
        await buffer.insert(splitByLines, startLine - 1);
        return 'Lines inserted successfully';
      }

      return 'Invalid mode specified';
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error editing lines:', error);
      throw new NeovimAPIError('EDIT_LINES_ERROR', 'Failed to edit lines', { startLine, mode, error });
    }
  }

  public async getWindows(): Promise<WindowInfo[]> {
    try {
      const nvim = await this.ensureConnected();
      const windows = await nvim.windows;
      const windowInfos: WindowInfo[] = [];

      for (const win of windows) {
        const buffer = await win.buffer;
        const [width, height] = await Promise.all([
          win.width,
          win.height
        ]);
        const position = await win.position;

        windowInfos.push({
          id: win.id,
          bufferId: buffer.id,
          width,
          height,
          row: position[0],
          col: position[1]
        });
      }

      return windowInfos;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error getting windows:', error);
      throw new NeovimAPIError('WINDOWS_ERROR', 'Failed to get windows', { error });
    }
  }

  public async manipulateWindow(command: string): Promise<string> {
    const validCommands = ['split', 'vsplit', 'only', 'close', 'wincmd h', 'wincmd j', 'wincmd k', 'wincmd l'];
    if (!validCommands.some(cmd => command.startsWith(cmd))) {
      throw new NeovimValidationError(`Invalid window command: ${command}`, 'command');
    }

    try {
      const nvim = await this.ensureConnected();
      
      // Use direct APIs for navigation commands
      if (command === 'wincmd h' || command === 'wincmd k') {
        // Move to previous window (left or up)
        const currentWindow = await nvim.window;
        const windows = await nvim.windows;
        const currentIndex = windows.findIndex(w => w.id === currentWindow.id);
        if (currentIndex > 0) {
          await nvim.setWindow(windows[currentIndex - 1]);
        }
        return `Moved to window ${command === 'wincmd h' ? 'left' : 'above'}`;
      } else if (command === 'wincmd j' || command === 'wincmd l') {
        // Move to next window (right or down)
        const currentWindow = await nvim.window;
        const windows = await nvim.windows;
        const currentIndex = windows.findIndex(w => w.id === currentWindow.id);
        if (currentIndex < windows.length - 1) {
          await nvim.setWindow(windows[currentIndex + 1]);
        }
        return `Moved to window ${command === 'wincmd j' ? 'below' : 'right'}`;
      } else if (command === 'close') {
        const currentWindow = await nvim.window;
        await currentWindow.close(true);
        return 'Window closed';
      } else {
        // For split, vsplit, only commands, still use nvim.command as they require complex operations
        await nvim.command(command);
        return 'Window command executed';
      }
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error manipulating window:', error);
      throw new NeovimAPIError('WINDOW_MANIPULATION_ERROR', 'Failed to manipulate window', { command, error });
    }
  }

  public async setMark(mark: string, line: number, col: number): Promise<string> {
    if (!/^[a-z]$/.test(mark)) {
      throw new NeovimValidationError('Invalid mark name (must be a-z)', 'mark');
    }
    if (line < 1) {
      throw new NeovimValidationError('Line must be >= 1', 'line');
    }
    if (col < 0) {
      throw new NeovimValidationError('Column must be >= 0', 'col');
    }

    try {
      const nvim = await this.ensureConnected();
      // Move cursor to position and set mark
      const window = await nvim.window;
      window.cursor = [line, col];
      await nvim.command(`mark ${mark}`);
      return `Mark ${mark} set at line ${line}, column ${col}`;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error setting mark:', error);
      throw new NeovimAPIError('SET_MARK_ERROR', 'Failed to set mark', { mark, line, col, error });
    }
  }

  public async setRegister(register: string, content: string): Promise<string> {
    const validRegisters = [...'abcdefghijklmnopqrstuvwxyz"'];
    if (!validRegisters.includes(register)) {
      throw new NeovimValidationError('Invalid register name', 'register');
    }

    try {
      const nvim = await this.ensureConnected();
      // Use callFunction instead of eval for better performance
      await nvim.callFunction('setreg', [register, content]);
      return `Register ${register} set`;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error setting register:', error);
      throw new NeovimAPIError('SET_REGISTER_ERROR', 'Failed to set register', { register, error });
    }
  }

  public async visualSelect(startLine: number, startCol: number, endLine: number, endCol: number): Promise<string> {
    if (startLine < 1 || endLine < 1) {
      throw new NeovimValidationError('Line numbers must be >= 1', 'startLine/endLine');
    }
    if (startCol < 0 || endCol < 0) {
      throw new NeovimValidationError('Column numbers must be >= 0', 'startCol/endCol');
    }

    try {
      const nvim = await this.ensureConnected();
      const window = await nvim.window;
      
      // Move cursor to start position first
      window.cursor = [startLine, startCol];
      
      // Enter visual mode and select to end position
      await nvim.input('v');
      window.cursor = [endLine, endCol];
      
      return 'Visual selection made';
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error making visual selection:', error);
      throw new NeovimAPIError('VISUAL_SELECT_ERROR', 'Failed to make visual selection', { startLine, startCol, endLine, endCol, error });
    }
  }

  public async switchBuffer(identifier: string | number): Promise<string> {
    if (!identifier) {
      throw new NeovimValidationError('Buffer identifier cannot be empty', 'identifier');
    }

    try {
      const nvim = await this.ensureConnected();
      
      // If identifier is a number, switch by buffer number using callFunction
      if (typeof identifier === 'number') {
        await nvim.callFunction('bufload', [identifier]);
        await nvim.callFunction('setbufvar', [identifier, '&buflisted', 1]);
        await nvim.command(`buffer ${identifier}`);
        return `Switched to buffer ${identifier}`;
      }
      
      // If identifier is a string, try to find buffer by name
      const buffers = await nvim.buffers;
      for (const buffer of buffers) {
        const bufName = await buffer.name;
        if (bufName === identifier || bufName.endsWith(identifier)) {
          await nvim.command(`buffer ${buffer.id}`);
          return `Switched to buffer: ${bufName}`;
        }
      }
      
      throw new NeovimValidationError(`Buffer not found: ${identifier}`);
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error switching buffer:', error);
      throw new NeovimAPIError('SWITCH_BUFFER_ERROR', 'Failed to switch buffer', { identifier, error });
    }
  }

  public async saveBuffer(filename?: string): Promise<string> {
    try {
      const nvim = await this.ensureConnected();
      
      if (filename) {
        // Save with specific filename
        await nvim.command(`write ${filename}`);
        return `Buffer saved to: ${filename}`;
      } else {
        // Save current buffer
        const buffer = await nvim.buffer;
        const bufferName = await buffer.name;
        
        if (!bufferName) {
          throw new NeovimValidationError('Cannot save unnamed buffer without specifying filename');
        }
        
        await nvim.command('write');
        return `Buffer saved: ${bufferName}`;
      }
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error saving buffer:', error);
      throw new NeovimAPIError('SAVE_BUFFER_ERROR', 'Failed to save buffer', { filename, error });
    }
  }

  public async openFile(filename: string): Promise<string> {
    if (!filename || filename.trim().length === 0) {
      throw new NeovimValidationError('Filename cannot be empty', 'filename');
    }
    
    try {
      const nvim = await this.ensureConnected();
      await nvim.command(`edit ${filename}`);
      return `Opened file: ${filename}`;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error opening file:', error);
      throw new NeovimAPIError('OPEN_FILE_ERROR', 'Failed to open file', { filename, error });
    }
  }

  public async searchInBuffer(pattern: string, options: { ignoreCase?: boolean; wholeWord?: boolean } = {}): Promise<string> {
    if (!pattern || pattern.trim().length === 0) {
      throw new NeovimValidationError('Search pattern cannot be empty', 'pattern');
    }
    
    try {
      const nvim = await this.ensureConnected();
      
      // Build search command with options
      let searchPattern = pattern;
      if (options.wholeWord) {
        searchPattern = `\\<${pattern}\\>`;
      }
      
      // Set search options
      if (options.ignoreCase) {
        await nvim.command('set ignorecase');
      } else {
        await nvim.command('set noignorecase');
      }
      
      // Perform search and get matches
      const matches = await nvim.eval(`searchcount({"pattern": "${searchPattern.replace(/"/g, '\\"')}", "maxcount": 100})`);
      const matchInfo = matches as { current: number; total: number; maxcount: number; incomplete: number };
      
      if (matchInfo.total === 0) {
        return `No matches found for: ${pattern}`;
      }
      
      // Move to first match
      await nvim.command(`/${searchPattern}`);
      
      return `Found ${matchInfo.total} matches for: ${pattern}${matchInfo.incomplete ? ' (showing first 100)' : ''}`;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error searching in buffer:', error);
      throw new NeovimAPIError('SEARCH_BUFFER_ERROR', 'Failed to search in buffer', { pattern, options, error });
    }
  }

  public async searchAndReplace(pattern: string, replacement: string, options: { global?: boolean; ignoreCase?: boolean; confirm?: boolean } = {}): Promise<string> {
    if (!pattern || pattern.trim().length === 0) {
      throw new NeovimValidationError('Search pattern cannot be empty', 'pattern');
    }
    
    try {
      const nvim = await this.ensureConnected();
      
      // Build substitute command
      let flags = '';
      if (options.global) flags += 'g';
      if (options.ignoreCase) flags += 'i';
      if (options.confirm) flags += 'c';
      
      const command = `%s/${pattern.replace(/\//g, '\\/')}/${replacement.replace(/\//g, '\\/')}/${flags}`;
      
      const result = await nvim.call('execute', [command]);
      return result ? String(result).trim() : 'Search and replace completed';
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error in search and replace:', error);
      throw new NeovimAPIError('SEARCH_REPLACE_ERROR', 'Failed to search and replace', { pattern, replacement, options, error });
    }
  }

  public async grepInProject(pattern: string, filePattern: string = '**/*'): Promise<string> {
    if (!pattern || pattern.trim().length === 0) {
      throw new NeovimValidationError('Grep pattern cannot be empty', 'pattern');
    }
    
    try {
      const nvim = await this.ensureConnected();
      
      // Use vimgrep for internal searching
      const command = `vimgrep /${pattern}/ ${filePattern}`;
      await nvim.command(command);
      
      // Get quickfix list
      const qflist = await nvim.eval('getqflist()');
      const results = qflist as Array<{ filename: string; lnum: number; text: string }>;
      
      if (results.length === 0) {
        return `No matches found for: ${pattern}`;
      }
      
      const summary = results.slice(0, 10).map(item => 
        `${item.filename}:${item.lnum}: ${item.text.trim()}`
      ).join('\n');
      
      const totalText = results.length > 10 ? `\n... and ${results.length - 10} more matches` : '';
      return `Found ${results.length} matches for: ${pattern}\n${summary}${totalText}`;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error in grep:', error);
      throw new NeovimAPIError('GREP_ERROR', 'Failed to grep in project', { pattern, filePattern, error });
    }
  }

  public async getOpenBuffers(): Promise<BufferInfo[]> {
    try {
      const nvim = await this.ensureConnected();
      const buffers = await nvim.buffers;
      const windows = await nvim.windows;
      const bufferInfos: BufferInfo[] = [];

      for (const buffer of buffers) {
        const [
          isLoaded,
          isListedOption,
          modified,
          syntax
        ] = await Promise.all([
          buffer.loaded,
          nvim.callFunction('getbufvar', [buffer.id, '&buflisted']),
          nvim.callFunction('getbufvar', [buffer.id, '&modified']),
          nvim.callFunction('getbufvar', [buffer.id, '&syntax'])
        ]);
        const isListed = Boolean(isListedOption);

        // Find windows containing this buffer
        const windowIds = [];
        for (const win of windows) {
          const winBuffer = await win.buffer;
          if (winBuffer.id === buffer.id) {
            windowIds.push(win.id);
          }
        }

        bufferInfos.push({
          number: buffer.id,
          name: await buffer.name,
          isListed,
          isLoaded,
          modified: Boolean(modified),
          syntax: String(syntax),
          windowIds
        });
      }

      return bufferInfos;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error getting open buffers:', error);
      throw new NeovimAPIError('GET_BUFFERS_ERROR', 'Failed to get open buffers', { error });
    }
  }

  public async manageMacro(action: string, register?: string, count: number = 1): Promise<string> {
    if (!['record', 'stop', 'play'].includes(action)) {
      throw new NeovimValidationError('Invalid macro action. Must be record, stop, or play', 'action');
    }
    if (count < 1) {
      throw new NeovimValidationError('Count must be >= 1', 'count');
    }

    try {
      const nvim = await this.ensureConnected();
      
      switch (action) {
        case 'record':
          if (!register || register.length !== 1 || !/[a-z]/.test(register)) {
            throw new NeovimValidationError('Register must be a single letter a-z for recording');
          }
          await nvim.input(`q${register}`);
          return `Started recording macro in register '${register}'`;
          
        case 'stop':
          await nvim.input('q');
          return 'Stopped recording macro';
          
        case 'play':
          if (!register || register.length !== 1 || !/[a-z]/.test(register)) {
            throw new NeovimValidationError('Register must be a single letter a-z for playing');
          }
          const playCommand = count > 1 ? `${count}@${register}` : `@${register}`;
          await nvim.input(playCommand);
          return `Played macro from register '${register}' ${count} time(s)`;
          
        default:
          throw new NeovimValidationError(`Unknown macro action: ${action}`);
      }
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error managing macro:', error);
      throw new NeovimAPIError('MACRO_ERROR', 'Failed to manage macro', { action, register, count, error });
    }
  }

  public async manageTab(action: string, filename?: string): Promise<string> {
    if (!['new', 'close', 'next', 'prev', 'first', 'last', 'list'].includes(action)) {
      throw new NeovimValidationError('Invalid tab action', 'action');
    }

    try {
      const nvim = await this.ensureConnected();
      
      switch (action) {
        case 'new':
          if (filename) {
            await nvim.command(`tabnew ${filename}`);
            return `Created new tab with file: ${filename}`;
          } else {
            await nvim.command('tabnew');
            return 'Created new empty tab';
          }
          
        case 'close':
          await nvim.command('tabclose');
          return 'Closed current tab';
          
        case 'next':
          await nvim.command('tabnext');
          return 'Moved to next tab';
          
        case 'prev':
          await nvim.command('tabprev');
          return 'Moved to previous tab';
          
        case 'first':
          await nvim.command('tabfirst');
          return 'Moved to first tab';
          
        case 'last':
          await nvim.command('tablast');
          return 'Moved to last tab';
          
        case 'list':
          const tabs = await nvim.tabpages;
          const tabInfo = [];
          for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i];
            const win = await tab.window;
            const buf = await win.buffer;
            const name = await buf.name;
            const current = await nvim.tabpage;
            const isCurrent = tab === current;
            tabInfo.push(`${isCurrent ? '*' : ' '}${i + 1}: ${name || '[No Name]'}`);
          }
          return `Tabs:\n${tabInfo.join('\n')}`;
          
        default:
          throw new NeovimValidationError(`Unknown tab action: ${action}`);
      }
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error managing tab:', error);
      throw new NeovimAPIError('TAB_ERROR', 'Failed to manage tab', { action, filename, error });
    }
  }

  public async manageFold(action: string, startLine?: number, endLine?: number): Promise<string> {
    if (!['create', 'open', 'close', 'toggle', 'openall', 'closeall', 'delete'].includes(action)) {
      throw new NeovimValidationError('Invalid fold action', 'action');
    }
    if (action === 'create' && (startLine === undefined || endLine === undefined)) {
      throw new NeovimValidationError('Start line and end line are required for creating folds', 'startLine/endLine');
    }

    try {
      const nvim = await this.ensureConnected();
      
      switch (action) {
        case 'create':
          if (startLine === undefined || endLine === undefined) {
            throw new NeovimValidationError('Start line and end line are required for creating folds');
          }
          await nvim.command(`${startLine},${endLine}fold`);
          return `Created fold from line ${startLine} to ${endLine}`;
          
        case 'open':
          await nvim.input('zo');
          return 'Opened fold at cursor';
          
        case 'close':
          await nvim.input('zc');
          return 'Closed fold at cursor';
          
        case 'toggle':
          await nvim.input('za');
          return 'Toggled fold at cursor';
          
        case 'openall':
          await nvim.command('normal! zR');
          return 'Opened all folds';
          
        case 'closeall':
          await nvim.command('normal! zM');
          return 'Closed all folds';
          
        case 'delete':
          await nvim.input('zd');
          return 'Deleted fold at cursor';
          
        default:
          throw new NeovimValidationError(`Unknown fold action: ${action}`);
      }
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error managing fold:', error);
      throw new NeovimAPIError('FOLD_ERROR', 'Failed to manage fold', { action, startLine, endLine, error });
    }
  }

  public async navigateJumpList(direction: string): Promise<string> {
    if (!['back', 'forward', 'list'].includes(direction)) {
      throw new NeovimValidationError('Invalid jump direction', 'direction');
    }

    try {
      const nvim = await this.ensureConnected();
      
      switch (direction) {
        case 'back':
          await nvim.input('\x0f'); // Ctrl-O
          return 'Jumped back in jump list';
          
        case 'forward':
          await nvim.input('\x09'); // Ctrl-I (Tab)
          return 'Jumped forward in jump list';
          
        case 'list':
          await nvim.command('jumps');
          // Get the output from the command
          const output = await nvim.eval('execute("jumps")');
          return `Jump list:\n${output}`;
          
        default:
          throw new NeovimValidationError(`Unknown jump direction: ${direction}`);
      }
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error navigating jump list:', error);
      throw new NeovimAPIError('JUMP_ERROR', 'Failed to navigate jump list', { direction, error });
    }
  }

  // LSP Integration Methods
  public async getLSPClients(): Promise<LSPClientInfo[]> {
    try {
      const nvim = await this.ensureConnected();
      
      try {
        const lspClients = await nvim.eval('luaeval("vim.lsp.get_clients()")');
        if (!Array.isArray(lspClients)) {
          return [];
        }

        return lspClients.map((client: any) => ({
          id: client.id || 0,
          name: client.name || 'unknown',
          capabilities: client.capabilities || {},
          attachedBuffers: client.attached_buffers || []
        }));
      } catch (e) {
        // Fallback for older Neovim versions
        const hasLsp = await nvim.eval('exists("*lsp#get_active_clients")');
        if (hasLsp) {
          try {
            const clients = await nvim.eval('lsp#get_active_clients()');
            return Array.isArray(clients) ? clients.map((client: any) => ({
              id: client.id || 0,
              name: client.name || 'unknown',
              capabilities: client.capabilities || {},
              attachedBuffers: []
            })) : [];
          } catch (e2) {
            return [];
          }
        }
        return [];
      }
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error getting LSP clients:', error);
      throw new NeovimAPIError('LSP_CLIENTS_ERROR', 'Failed to get LSP clients', { error });
    }
  }

  public async getLSPDiagnostics(bufferId?: number): Promise<any[]> {
    try {
      const nvim = await this.ensureConnected();
      
      try {
        const diagnostics = await nvim.eval('luaeval("vim.diagnostic.get()")');
        return Array.isArray(diagnostics) ? diagnostics : [];
      } catch (e) {
        // Fallback for older Neovim versions
        const hasDiagnostics = await nvim.eval('exists("*lsp#get_buffer_diagnostics")');
        if (hasDiagnostics) {
          try {
            const diagnostics = await nvim.eval('lsp#get_buffer_diagnostics()');
            return Array.isArray(diagnostics) ? diagnostics : [];
          } catch (e2) {
            return [];
          }
        }
        return [];
      }
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error getting LSP diagnostics:', error);
      throw new NeovimAPIError('LSP_DIAGNOSTICS_ERROR', 'Failed to get LSP diagnostics', { bufferId, error });
    }
  }

  public async executeLSPAction(action: string, params?: any): Promise<any> {
    if (!action) {
      throw new NeovimValidationError('LSP action cannot be empty', 'action');
    }

    try {
      const nvim = await this.ensureConnected();
      
      switch (action) {
        case 'hover':
          await nvim.command('lua vim.lsp.buf.hover()');
          return 'LSP hover information displayed';
          
        case 'definition':
          await nvim.command('lua vim.lsp.buf.definition()');
          return 'Jumped to definition';
          
        case 'references':
          await nvim.command('lua vim.lsp.buf.references()');
          return 'Found references';
          
        case 'rename':
          if (!params || !params.newName) {
            throw new NeovimValidationError('New name is required for rename action', 'params.newName');
          }
          await nvim.eval(`lua vim.lsp.buf.rename('${params.newName.replace(/'/g, "''")}')`);
          return `Renamed to ${params.newName}`;
          
        case 'format':
          await nvim.command('lua vim.lsp.buf.format()');
          return 'Buffer formatted';
          
        case 'code_action':
          await nvim.command('lua vim.lsp.buf.code_action()');
          return 'Code actions available';
          
        default:
          throw new NeovimValidationError(`Unknown LSP action: ${action}`, 'action');
      }
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error executing LSP action:', error);
      throw new NeovimAPIError('LSP_ACTION_ERROR', 'Failed to execute LSP action', { action, params, error });
    }
  }

  // Advanced Search with Structured Results
  public async searchWithMatches(pattern: string, options: { 
    ignoreCase?: boolean; 
    wholeWord?: boolean;
    maxResults?: number;
  } = {}): Promise<Array<{
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    text: string;
    groups?: string[];
  }>> {
    if (!pattern || pattern.trim().length === 0) {
      throw new NeovimValidationError('Search pattern cannot be empty', 'pattern');
    }

    try {
      const nvim = await this.ensureConnected();
      const buffer = await nvim.buffer;
      
      // Build search pattern
      let searchPattern = pattern;
      if (options.wholeWord) {
        searchPattern = `\\<${pattern}\\>`;
      }
      
      // Get all lines
      const lines = await buffer.getLines({ start: 0, end: -1, strictIndexing: false });
      const matches: Array<{
        line: number;
        column: number;
        endLine: number;
        endColumn: number;
        text: string;
        groups?: string[];
      }> = [];
      
      // Create regex for matching
      const flags = options.ignoreCase ? 'gi' : 'g';
      const regex = new RegExp(searchPattern, flags);
      
      lines.forEach((line, lineIndex) => {
        let match;
        while ((match = regex.exec(line)) !== null) {
          if (options.maxResults && matches.length >= options.maxResults) {
            break;
          }
          
          matches.push({
            line: lineIndex + 1,
            column: match.index,
            endLine: lineIndex + 1,
            endColumn: match.index + match[0].length,
            text: match[0],
            groups: match.length > 1 ? match.slice(1) : undefined
          });
        }
      });
      
      return matches;
    } catch (error) {
      if (error instanceof NeovimAPIError) {
        throw error;
      }
      console.error('Error in structured search:', error);
      throw new NeovimAPIError('STRUCTURED_SEARCH_ERROR', 'Failed to perform structured search', { pattern, options, error });
    }
  }
}
