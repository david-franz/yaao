import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { CommandModule } from '../command.js';
import type { CliContext } from '../context.js';
import { serve } from '../../mcp/server.js';

interface ServeFlags {
  stdio?: boolean;
}

export const serveCommand: CommandModule = {
  name: 'serve',
  describe: 'Start the yaao MCP server (default transport: stdio)',
  register(program: Command, ctx: CliContext) {
    program
      .command('serve')
      .description('Start the yaao MCP server (default transport: stdio)')
      .option('--stdio', 'use stdio transport (default)', true)
      .action(async (_flags: ServeFlags) => {
        // We deliberately don't write a log line to stdout — that's the MCP protocol
        // channel and any noise would corrupt it. A startup line to stderr helps
        // operators confirm the server is alive when launched outside a parent agent.
        process.stderr.write(`yaao serve ready (stdio) cwd=${resolve(ctx.cwd)}\n`);
        await serve({ cwd: resolve(ctx.cwd), config: ctx.config });
        // serve() resolves when the transport closes (parent disconnects). Exit cleanly.
        ctx.exit(0);
      });
  },
};
