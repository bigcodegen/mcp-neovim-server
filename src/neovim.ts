import { attach, Neovim } from 'neovim';

export class NeovimConnectionError extends Error {
  constructor(socketPath: string, cause?: Error) {
    super(`Failed to connect to Neovim at ${socketPath}. Is Neovim running with --listen ${socketPath}?`);
    this.name = 'NeovimConnectionError';
    this.cause = cause;
  }
}

export class NeovimCommandError extends Error {
  constructor(command: string, originalError: string) {
    super(`Failed to execute command '${command}': ${originalError}`);
    this.name = 'NeovimCommandError';
  }
}

export class NeovimValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeovimValidationError';
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

export class NeovimManager {
  private static instance: NeovimManager;

  private constructor() { }

  public static getInstance(): NeovimManager {
    if (!NeovimManager.instance) {
      NeovimManager.instance = new NeovimManager();
    }
    return NeovimManager.instance;
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const nvim = await this.connect();
      await nvim.eval('1'); // Simple test
      return true;
    } catch {
      return false;
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
      const nvim = await this.connect();
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
          throw new NeovimValidationError(`Buffer not found: ${filename}`);
        }
        buffer = targetBuffer;
      } else {
        buffer = await nvim.buffer;
      }
      
      const lines = await buffer.lines;
      const lineMap = new Map<number, string>();

      lines.forEach((line: string, index: number) => {
        lineMap.set(index + 1, line);
      });

      return lineMap;
    } catch (error) {
      if (error instanceof NeovimValidationError) {
        throw error;
      }
      console.error('Error getting buffer contents:', error);
      return new Map();
    }
  }

  public async sendCommand(command: string): Promise<string> {
    if (!command || command.trim().length === 0) {
      throw new NeovimValidationError('Command cannot be empty');
    }

    try {
      const nvim = await this.connect();

      // Remove leading colon if present
      const normalizedCommand = command.startsWith(':') ? command.substring(1) : command;

      // Handle shell commands (starting with !)
      if (normalizedCommand.startsWith('!')) {
        if (process.env.ALLOW_SHELL_COMMANDS !== 'true') {
          return 'Shell command execution is disabled. Set ALLOW_SHELL_COMMANDS=true environment variable to enable shell commands.';
        }

        const shellCommand = normalizedCommand.substring(1).trim();
        if (!shellCommand) {
          throw new NeovimValidationError('Shell command cannot be empty');
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
      if (error instanceof NeovimCommandError || error instanceof NeovimValidationError) {
        throw error;
      }
      console.error('Error sending command:', error);
      throw new NeovimCommandError(command, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async getNeovimStatus(): Promise<NeovimStatus | string> {
    try {
      const nvim = await this.connect();
      const window = await nvim.window;
      const cursor = await window.cursor;
      const mode = await nvim.mode;
      const buffer = await nvim.buffer;
      
      // Get window layout
      const layout = await nvim.eval('winlayout()');
      const tabpage = await nvim.tabpage;
      const currentTab = await tabpage.number;

      // Get marks (a-z) - only include set marks
      const marks: { [key: string]: [number, number] } = {};
      for (const mark of 'abcdefghijklmnopqrstuvwxyz') {
        try {
          const pos = await nvim.eval(`getpos("'${mark}")`) as [number, number, number, number];
          // Only include marks that are actually set (not at position 0,0)
          if (pos[1] > 0 && pos[2] > 0) {
            marks[mark] = [pos[1], pos[2]];
          }
        } catch (e) {
          // Mark not set
        }
      }

      // Get registers (a-z, ", 0-9) - only include non-empty registers
      const registers: { [key: string]: string } = {};
      const registerNames = [...'abcdefghijklmnopqrstuvwxyz', '"', ...Array(10).keys()];
      for (const reg of registerNames) {
        try {
          const content = String(await nvim.eval(`getreg('${reg}')`));
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

      const neovimStatus: NeovimStatus = {
        cursorPosition: cursor,
        mode: mode.mode,
        visualSelection: '',
        fileName: await buffer.name,
        windowLayout: JSON.stringify(layout),
        currentTab,
        marks,
        registers,
        cwd,
        lspInfo,
        pluginInfo
      };

      if (mode.mode.startsWith('v') || mode.mode.startsWith('V')) {
        try {
          // Use a more reliable method to get the visual selection
          // This Lua code gets the actual selected text
          const visualText = await nvim.lua(`
            local mode = vim.fn.visualmode()
            if mode == '' then
              return ''
            end
            
            -- Save current register content
            local save_reg = vim.fn.getreg('"')
            local save_regtype = vim.fn.getregtype('"')
            
            -- Yank the visual selection to unnamed register
            vim.cmd('normal! "vy')
            
            -- Get the yanked text
            local selected_text = vim.fn.getreg('"')
            
            -- Restore the register
            vim.fn.setreg('"', save_reg, save_regtype)
            
            return selected_text
          `);
          
          neovimStatus.visualSelection = String(visualText || '');
        } catch (e) {
          // Fallback method using getpos and getline
          try {
            const start = await nvim.eval(`getpos("'<")`) as [number, number, number, number];
            const end = await nvim.eval(`getpos("'>")`) as [number, number, number, number];
            
            if (start[1] === end[1]) {
              // Single line selection
              const line = await nvim.eval(`getline(${start[1]})`) as string;
              const startCol = start[2] - 1; // Convert to 0-based
              const endCol = end[2]; // Keep 1-based for substring end
              neovimStatus.visualSelection = line.substring(startCol, endCol);
            } else {
              // Multi-line selection
              const lines = await nvim.eval(`getline(${start[1]}, ${end[1]})`) as string[];
              if (lines && lines.length > 0) {
                const result = [];
                const startCol = start[2] - 1;
                const endCol = end[2];
                
                // First line: from start column to end
                result.push(lines[0].substring(startCol));
                
                // Middle lines: complete lines
                for (let i = 1; i < lines.length - 1; i++) {
                  result.push(lines[i]);
                }
                
                // Last line: from beginning to end column
                if (lines.length > 1) {
                  result.push(lines[lines.length - 1].substring(0, endCol));
                }
                
                neovimStatus.visualSelection = result.join('\n');
              }
            }
          } catch (e2) {
            neovimStatus.visualSelection = '';
          }
        }
      }

      return neovimStatus;
    } catch (error) {
      console.error('Error getting Neovim status:', error);
      return 'Error getting Neovim status';
    }
  }

  public async editLines(startLine: number, mode: 'replace' | 'insert' | 'replaceAll', newText: string): Promise<string> {
    try {
      const nvim = await this.connect();
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
      console.error('Error editing lines:', error);
      return 'Error editing lines';
    }
  }

  public async getWindows(): Promise<WindowInfo[]> {
    try {
      const nvim = await this.connect();
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
      console.error('Error getting windows:', error);
      return [];
    }
  }

  public async manipulateWindow(command: string): Promise<string> {
    const validCommands = ['split', 'vsplit', 'only', 'close', 'wincmd h', 'wincmd j', 'wincmd k', 'wincmd l'];
    if (!validCommands.some(cmd => command.startsWith(cmd))) {
      return 'Invalid window command';
    }

    try {
      const nvim = await this.connect();
      await nvim.command(command);
      return 'Window command executed';
    } catch (error) {
      console.error('Error manipulating window:', error);
      return 'Error executing window command';
    }
  }

  public async setMark(mark: string, line: number, col: number): Promise<string> {
    if (!/^[a-z]$/.test(mark)) {
      return 'Invalid mark name (must be a-z)';
    }

    try {
      const nvim = await this.connect();
      await nvim.command(`mark ${mark}`);
      const window = await nvim.window;
      await (window.cursor = [line, col]);
      return `Mark ${mark} set at line ${line}, column ${col}`;
    } catch (error) {
      console.error('Error setting mark:', error);
      return 'Error setting mark';
    }
  }

  public async setRegister(register: string, content: string): Promise<string> {
    const validRegisters = [...'abcdefghijklmnopqrstuvwxyz"'];
    if (!validRegisters.includes(register)) {
      return 'Invalid register name';
    }

    try {
      const nvim = await this.connect();
      await nvim.eval(`setreg('${register}', '${content.replace(/'/g, "''")}')`);
      return `Register ${register} set`;
    } catch (error) {
      console.error('Error setting register:', error);
      return 'Error setting register';
    }
  }

  public async visualSelect(startLine: number, startCol: number, endLine: number, endCol: number): Promise<string> {
    try {
      const nvim = await this.connect();
      const window = await nvim.window;
      
      // Enter visual mode
      await nvim.command('normal! v');
      
      // Move cursor to start position
      await (window.cursor = [startLine, startCol]);
      
      // Move cursor to end position (selection will be made)
      await (window.cursor = [endLine, endCol]);
      
      return 'Visual selection made';
    } catch (error) {
      console.error('Error making visual selection:', error);
      return 'Error making visual selection';
    }
  }

  public async switchBuffer(identifier: string | number): Promise<string> {
    try {
      const nvim = await this.connect();
      
      // If identifier is a number, switch by buffer number
      if (typeof identifier === 'number') {
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
      if (error instanceof NeovimValidationError) {
        throw error;
      }
      console.error('Error switching buffer:', error);
      throw new NeovimCommandError(`buffer switch to ${identifier}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async saveBuffer(filename?: string): Promise<string> {
    try {
      const nvim = await this.connect();
      
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
      if (error instanceof NeovimValidationError) {
        throw error;
      }
      console.error('Error saving buffer:', error);
      throw new NeovimCommandError(`save ${filename || 'current buffer'}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async openFile(filename: string): Promise<string> {
    if (!filename || filename.trim().length === 0) {
      throw new NeovimValidationError('Filename cannot be empty');
    }
    
    try {
      const nvim = await this.connect();
      await nvim.command(`edit ${filename}`);
      return `Opened file: ${filename}`;
    } catch (error) {
      console.error('Error opening file:', error);
      throw new NeovimCommandError(`edit ${filename}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async searchInBuffer(pattern: string, options: { ignoreCase?: boolean; wholeWord?: boolean } = {}): Promise<string> {
    if (!pattern || pattern.trim().length === 0) {
      throw new NeovimValidationError('Search pattern cannot be empty');
    }
    
    try {
      const nvim = await this.connect();
      
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
      console.error('Error searching in buffer:', error);
      throw new NeovimCommandError(`search for ${pattern}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async searchAndReplace(pattern: string, replacement: string, options: { global?: boolean; ignoreCase?: boolean; confirm?: boolean } = {}): Promise<string> {
    if (!pattern || pattern.trim().length === 0) {
      throw new NeovimValidationError('Search pattern cannot be empty');
    }
    
    try {
      const nvim = await this.connect();
      
      // Build substitute command
      let flags = '';
      if (options.global) flags += 'g';
      if (options.ignoreCase) flags += 'i';
      if (options.confirm) flags += 'c';
      
      const command = `%s/${pattern.replace(/\//g, '\\/')}/${replacement.replace(/\//g, '\\/')}/${flags}`;
      
      const result = await nvim.call('execute', [command]);
      return result ? String(result).trim() : 'Search and replace completed';
    } catch (error) {
      console.error('Error in search and replace:', error);
      throw new NeovimCommandError(`substitute ${pattern} -> ${replacement}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async grepInProject(pattern: string, filePattern: string = '**/*'): Promise<string> {
    if (!pattern || pattern.trim().length === 0) {
      throw new NeovimValidationError('Grep pattern cannot be empty');
    }
    
    try {
      const nvim = await this.connect();
      
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
      console.error('Error in grep:', error);
      throw new NeovimCommandError(`grep ${pattern}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async getOpenBuffers(): Promise<BufferInfo[]> {
    try {
      const nvim = await this.connect();
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
          buffer.getOption('buflisted'),
          buffer.getOption('modified'),
          buffer.getOption('syntax')
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
      console.error('Error getting open buffers:', error);
      return [];
    }
  }

  public async manageMacro(action: string, register?: string, count: number = 1): Promise<string> {
    try {
      const nvim = await this.connect();
      
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
      if (error instanceof NeovimValidationError) {
        throw error;
      }
      console.error('Error managing macro:', error);
      throw new NeovimCommandError(`macro ${action}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async manageTab(action: string, filename?: string): Promise<string> {
    try {
      const nvim = await this.connect();
      
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
      if (error instanceof NeovimValidationError) {
        throw error;
      }
      console.error('Error managing tab:', error);
      throw new NeovimCommandError(`tab ${action}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async manageFold(action: string, startLine?: number, endLine?: number): Promise<string> {
    try {
      const nvim = await this.connect();
      
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
      if (error instanceof NeovimValidationError) {
        throw error;
      }
      console.error('Error managing fold:', error);
      throw new NeovimCommandError(`fold ${action}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  public async navigateJumpList(direction: string): Promise<string> {
    try {
      const nvim = await this.connect();
      
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
      if (error instanceof NeovimValidationError) {
        throw error;
      }
      console.error('Error navigating jump list:', error);
      throw new NeovimCommandError(`jump ${direction}`, error instanceof Error ? error.message : 'Unknown error');
    }
  }
}
